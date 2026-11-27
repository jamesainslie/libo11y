//! In-process loopback OTLP receivers (HTTP and gRPC) for end-to-end wire
//! tests.
//!
//! Both [`OtlpHttpReceiver`] and [`OtlpGrpcReceiver`] bind `127.0.0.1:0`
//! synchronously and serve on a dedicated background thread with a bounded
//! runtime, so they work identically from synchronous `#[test]` functions and
//! asynchronous `#[tokio::test]` functions and never leak tasks or sockets
//! when shut down or dropped.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Read as _};
use std::net::{SocketAddr, TcpListener as StdTcpListener};
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::thread::JoinHandle;
use std::time::Duration;

use flate2::read::GzDecoder;
use http::{Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt as _, Full, LengthLimitError, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use opentelemetry_proto::tonic::collector::logs::v1::{
    ExportLogsServiceRequest, ExportLogsServiceResponse,
    logs_service_server::{LogsService, LogsServiceServer},
};
use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, ExportMetricsServiceResponse,
    metrics_service_server::{MetricsService, MetricsServiceServer},
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
    trace_service_server::{TraceService, TraceServiceServer},
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinSet;
use tonic::codec::CompressionEncoding;

/// Maximum request body size (both compressed and decompressed) accepted by
/// [`OtlpHttpReceiver`].
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Maximum time [`OtlpGrpcReceiver`] waits for open HTTP/2 connections to
/// drain after shutdown is signaled before aborting them.
const GRPC_SHUTDOWN_GRACE: Duration = Duration::from_millis(200);

#[derive(Default)]
struct Received {
    traces: Vec<ExportTraceServiceRequest>,
    metrics: Vec<ExportMetricsServiceRequest>,
    logs: Vec<ExportLogsServiceRequest>,
    headers: Vec<BTreeMap<String, String>>,
}

struct ServerHandle {
    shutdown_tx: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl ServerHandle {
    fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// An in-process OTLP/HTTP receiver listening on an ephemeral loopback port.
///
/// Serves `POST /v1/traces`, `POST /v1/metrics`, and `POST /v1/logs`,
/// accepting both `application/x-protobuf` and `application/json` payloads
/// with optional `Content-Encoding: gzip` decompression.
pub struct OtlpHttpReceiver {
    addr: SocketAddr,
    received: Arc<Mutex<Received>>,
    handle: Mutex<ServerHandle>,
}

impl fmt::Debug for OtlpHttpReceiver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OtlpHttpReceiver")
            .field("addr", &self.addr)
            .finish_non_exhaustive()
    }
}

impl OtlpHttpReceiver {
    /// Binds `127.0.0.1:0` and starts serving OTLP/HTTP requests.
    ///
    /// # Errors
    ///
    /// Returns any I/O error encountered while binding the socket or spawning
    /// the server thread.
    pub fn start() -> io::Result<Self> {
        let std_listener = StdTcpListener::bind("127.0.0.1:0")?;
        std_listener.set_nonblocking(true)?;
        let addr = std_listener.local_addr()?;

        let received = Arc::new(Mutex::new(Received::default()));
        let sink = Arc::clone(&received);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<io::Result<()>>();

        let thread = std::thread::Builder::new()
            .name("libo11y-test-otlp-http".to_owned())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let listener = match TcpListener::from_std(std_listener) {
                        Ok(l) => l,
                        Err(err) => {
                            let _ = ready_tx.send(Err(err));
                            return;
                        }
                    };
                    let _ = ready_tx.send(Ok(()));
                    serve_http(listener, sink, shutdown_rx).await;
                });
            })?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                addr,
                received,
                handle: Mutex::new(ServerHandle {
                    shutdown_tx: Some(shutdown_tx),
                    thread: Some(thread),
                }),
            }),
            Ok(Err(err)) => {
                let _ = thread.join();
                Err(err)
            }
            Err(_) => {
                let _ = thread.join();
                Err(io::Error::other(
                    "OTLP/HTTP receiver thread exited before starting",
                ))
            }
        }
    }

    /// Base endpoint URL (`http://127.0.0.1:<port>`), suitable for
    /// `OTEL_EXPORTER_OTLP_ENDPOINT`.
    #[must_use]
    pub fn endpoint(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// The bound loopback socket address.
    #[must_use]
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// All decoded `ExportTraceServiceRequest` payloads received so far.
    #[must_use]
    pub fn traces(&self) -> Vec<ExportTraceServiceRequest> {
        self.received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .traces
            .clone()
    }

    /// All decoded `ExportMetricsServiceRequest` payloads received so far.
    #[must_use]
    pub fn metrics(&self) -> Vec<ExportMetricsServiceRequest> {
        self.received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .metrics
            .clone()
    }

    /// All decoded `ExportLogsServiceRequest` payloads received so far.
    #[must_use]
    pub fn logs(&self) -> Vec<ExportLogsServiceRequest> {
        self.received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .logs
            .clone()
    }

    /// Captured lowercased HTTP request headers for every accepted request, in
    /// receipt order.
    #[must_use]
    pub fn headers(&self) -> Vec<BTreeMap<String, String>> {
        self.received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .headers
            .clone()
    }

    /// Clears all recorded payloads and headers.
    pub fn clear(&self) {
        let mut guard = self.received.lock().unwrap_or_else(PoisonError::into_inner);
        guard.traces.clear();
        guard.metrics.clear();
        guard.logs.clear();
        guard.headers.clear();
    }

    /// Stops the receiver and joins its background thread. Safe to call
    /// multiple times; also invoked automatically on [`Drop`].
    pub fn shutdown(&self) {
        self.handle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .shutdown();
    }
}

impl Drop for OtlpHttpReceiver {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn serve_http(
    listener: TcpListener,
    sink: Arc<Mutex<Received>>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown_rx => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let sink = Arc::clone(&sink);
                        connections.spawn(async move {
                            let io = TokioIo::new(stream);
                            let service = service_fn(move |req| {
                                handle_http_request(req, Arc::clone(&sink))
                            });
                            let _ = http1::Builder::new().serve_connection(io, service).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        }
    }
    drop(listener);
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

#[derive(Clone, Copy)]
enum WireEncoding {
    Protobuf,
    Json,
}

async fn handle_http_request(
    req: Request<Incoming>,
    sink: Arc<Mutex<Received>>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    if req.method() != Method::POST {
        return Ok(text_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "method not allowed",
        ));
    }

    let path = req.uri().path().to_owned();
    if !matches!(path.as_str(), "/v1/traces" | "/v1/metrics" | "/v1/logs") {
        return Ok(text_response(StatusCode::NOT_FOUND, "not found"));
    }

    let mut hdrs = BTreeMap::new();
    for (name, value) in req.headers() {
        if let Ok(val) = value.to_str() {
            hdrs.insert(name.as_str().to_ascii_lowercase(), val.to_owned());
        }
    }

    let encoding = match hdrs
        .get("content-type")
        .map(|s| {
            s.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .as_deref()
    {
        None | Some("" | "application/x-protobuf") => WireEncoding::Protobuf,
        Some("application/json") => WireEncoding::Json,
        Some(_) => {
            return Ok(text_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported content-type",
            ));
        }
    };

    let is_gzip = hdrs
        .get("content-encoding")
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("gzip"));

    let raw_bytes = match Limited::new(req.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
    {
        Ok(collected) => collected.to_bytes(),
        Err(err) => {
            if err.downcast_ref::<LengthLimitError>().is_some() {
                return Ok(text_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request body too large",
                ));
            }
            return Ok(text_response(
                StatusCode::BAD_REQUEST,
                &format!("reading body: {err}"),
            ));
        }
    };

    let payload = if is_gzip {
        let limit = u64::try_from(MAX_BODY_BYTES)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        let mut gz = GzDecoder::new(raw_bytes.as_ref()).take(limit);
        let mut uncompressed = Vec::new();
        if let Err(err) = gz.read_to_end(&mut uncompressed) {
            return Ok(text_response(
                StatusCode::BAD_REQUEST,
                &format!("gunzip body: {err}"),
            ));
        }
        if uncompressed.len() > MAX_BODY_BYTES {
            return Ok(text_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "decompressed body too large",
            ));
        }
        uncompressed
    } else {
        raw_bytes.to_vec()
    };

    let response_body = match dispatch_http_signal(&path, &payload, encoding, hdrs, &sink) {
        Ok(body) => body,
        Err((status, msg)) => return Ok(text_response(status, &msg)),
    };

    let content_type = match encoding {
        WireEncoding::Protobuf => "application/x-protobuf",
        WireEncoding::Json => "application/json",
    };
    let resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .body(Full::new(Bytes::from(response_body)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())));
    Ok(resp)
}

fn dispatch_http_signal(
    path: &str,
    payload: &[u8],
    encoding: WireEncoding,
    hdrs: BTreeMap<String, String>,
    sink: &Mutex<Received>,
) -> Result<Vec<u8>, (StatusCode, String)> {
    match path {
        "/v1/traces" => {
            let msg = decode_payload::<ExportTraceServiceRequest>(payload, encoding)
                .map_err(|err| (StatusCode::BAD_REQUEST, err))?;
            let mut guard = sink.lock().unwrap_or_else(PoisonError::into_inner);
            guard.headers.push(hdrs);
            guard.traces.push(msg);
            Ok(empty_response_body(
                &ExportTraceServiceResponse::default(),
                encoding,
            ))
        }
        "/v1/metrics" => {
            let msg = decode_payload::<ExportMetricsServiceRequest>(payload, encoding)
                .map_err(|err| (StatusCode::BAD_REQUEST, err))?;
            let mut guard = sink.lock().unwrap_or_else(PoisonError::into_inner);
            guard.headers.push(hdrs);
            guard.metrics.push(msg);
            Ok(empty_response_body(
                &ExportMetricsServiceResponse::default(),
                encoding,
            ))
        }
        "/v1/logs" => {
            let msg = decode_payload::<ExportLogsServiceRequest>(payload, encoding)
                .map_err(|err| (StatusCode::BAD_REQUEST, err))?;
            let mut guard = sink.lock().unwrap_or_else(PoisonError::into_inner);
            guard.headers.push(hdrs);
            guard.logs.push(msg);
            Ok(empty_response_body(
                &ExportLogsServiceResponse::default(),
                encoding,
            ))
        }
        _ => Err((StatusCode::NOT_FOUND, "not found".to_owned())),
    }
}

fn decode_payload<M>(payload: &[u8], encoding: WireEncoding) -> Result<M, String>
where
    M: prost::Message + Default + serde::de::DeserializeOwned,
{
    match encoding {
        WireEncoding::Protobuf => {
            M::decode(payload).map_err(|err| format!("decoding protobuf: {err}"))
        }
        WireEncoding::Json => {
            serde_json::from_slice(payload).map_err(|err| format!("decoding json: {err}"))
        }
    }
}

fn empty_response_body<M: prost::Message>(msg: &M, encoding: WireEncoding) -> Vec<u8> {
    match encoding {
        WireEncoding::Protobuf => msg.encode_to_vec(),
        WireEncoding::Json => b"{}".to_vec(),
    }
}

fn text_response(status: StatusCode, msg: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Full::new(Bytes::copy_from_slice(msg.as_bytes())))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

/// An in-process OTLP/gRPC receiver listening on an ephemeral loopback port.
///
/// Serves the OpenTelemetry `TraceService`, `MetricsService`, and
/// `LogsService` gRPC services, accepting gzip-compressed requests and
/// recording payloads and ASCII metadata headers.
pub struct OtlpGrpcReceiver {
    addr: SocketAddr,
    received: Arc<Mutex<Received>>,
    handle: Mutex<ServerHandle>,
}

impl fmt::Debug for OtlpGrpcReceiver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OtlpGrpcReceiver")
            .field("addr", &self.addr)
            .finish_non_exhaustive()
    }
}

impl OtlpGrpcReceiver {
    /// Binds `127.0.0.1:0` and starts serving OTLP/gRPC requests.
    ///
    /// # Errors
    ///
    /// Returns any I/O error encountered while binding the socket or spawning
    /// the server thread.
    pub fn start() -> io::Result<Self> {
        let std_listener = StdTcpListener::bind("127.0.0.1:0")?;
        std_listener.set_nonblocking(true)?;
        let addr = std_listener.local_addr()?;

        let received = Arc::new(Mutex::new(Received::default()));
        let svc = GrpcServices {
            received: Arc::clone(&received),
        };
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<io::Result<()>>();

        let thread = std::thread::Builder::new()
            .name("libo11y-test-otlp-grpc".to_owned())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let listener = match TcpListener::from_std(std_listener) {
                        Ok(l) => l,
                        Err(err) => {
                            let _ = ready_tx.send(Err(err));
                            return;
                        }
                    };
                    let incoming = TcpIncoming(listener);
                    let (graceful_tx, graceful_rx) = oneshot::channel();
                    let mut server_task = tokio::spawn(async move {
                        let _ = tonic::transport::Server::builder()
                            .add_service(
                                TraceServiceServer::new(svc.clone())
                                    .accept_compressed(CompressionEncoding::Gzip),
                            )
                            .add_service(
                                MetricsServiceServer::new(svc.clone())
                                    .accept_compressed(CompressionEncoding::Gzip),
                            )
                            .add_service(
                                LogsServiceServer::new(svc)
                                    .accept_compressed(CompressionEncoding::Gzip),
                            )
                            .serve_with_incoming_shutdown(incoming, async move {
                                let _ = graceful_rx.await;
                            })
                            .await;
                    });
                    let _ = ready_tx.send(Ok(()));
                    tokio::select! {
                        _ = &mut server_task => {}
                        _ = shutdown_rx => {
                            let _ = graceful_tx.send(());
                            tokio::select! {
                                _ = &mut server_task => {}
                                () = tokio::time::sleep(GRPC_SHUTDOWN_GRACE) => {
                                    server_task.abort();
                                    let _ = server_task.await;
                                }
                            }
                        }
                    }
                });
                runtime.shutdown_timeout(GRPC_SHUTDOWN_GRACE);
            })?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                addr,
                received,
                handle: Mutex::new(ServerHandle {
                    shutdown_tx: Some(shutdown_tx),
                    thread: Some(thread),
                }),
            }),
            Ok(Err(err)) => {
                let _ = thread.join();
                Err(err)
            }
            Err(_) => {
                let _ = thread.join();
                Err(io::Error::other(
                    "OTLP/gRPC receiver thread exited before starting",
                ))
            }
        }
    }

    /// Endpoint URL (`http://127.0.0.1:<port>`), suitable for
    /// `OTEL_EXPORTER_OTLP_ENDPOINT`.
    #[must_use]
    pub fn endpoint(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// The bound loopback socket address.
    #[must_use]
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// All decoded `ExportTraceServiceRequest` payloads received so far.
    #[must_use]
    pub fn traces(&self) -> Vec<ExportTraceServiceRequest> {
        self.received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .traces
            .clone()
    }

    /// All decoded `ExportMetricsServiceRequest` payloads received so far.
    #[must_use]
    pub fn metrics(&self) -> Vec<ExportMetricsServiceRequest> {
        self.received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .metrics
            .clone()
    }

    /// All decoded `ExportLogsServiceRequest` payloads received so far.
    #[must_use]
    pub fn logs(&self) -> Vec<ExportLogsServiceRequest> {
        self.received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .logs
            .clone()
    }

    /// Captured lowercased ASCII metadata headers for every RPC, in receipt
    /// order.
    #[must_use]
    pub fn headers(&self) -> Vec<BTreeMap<String, String>> {
        self.received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .headers
            .clone()
    }

    /// Clears all recorded payloads and headers.
    pub fn clear(&self) {
        let mut guard = self.received.lock().unwrap_or_else(PoisonError::into_inner);
        guard.traces.clear();
        guard.metrics.clear();
        guard.logs.clear();
        guard.headers.clear();
    }

    /// Stops the receiver and joins its background thread. Safe to call
    /// multiple times; also invoked automatically on [`Drop`].
    pub fn shutdown(&self) {
        self.handle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .shutdown();
    }
}

impl Drop for OtlpGrpcReceiver {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Clone)]
struct GrpcServices {
    received: Arc<Mutex<Received>>,
}

fn extract_grpc_metadata(meta: &tonic::metadata::MetadataMap) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for entry in meta.iter() {
        if let tonic::metadata::KeyAndValueRef::Ascii(key, value) = entry
            && let Ok(val) = value.to_str()
        {
            out.insert(key.as_str().to_ascii_lowercase(), val.to_owned());
        }
    }
    out
}

#[tonic::async_trait]
impl TraceService for GrpcServices {
    async fn export(
        &self,
        request: tonic::Request<ExportTraceServiceRequest>,
    ) -> Result<tonic::Response<ExportTraceServiceResponse>, tonic::Status> {
        let hdrs = extract_grpc_metadata(request.metadata());
        let mut guard = self.received.lock().unwrap_or_else(PoisonError::into_inner);
        guard.headers.push(hdrs);
        guard.traces.push(request.into_inner());
        Ok(tonic::Response::new(ExportTraceServiceResponse {
            partial_success: None,
        }))
    }
}

#[tonic::async_trait]
impl MetricsService for GrpcServices {
    async fn export(
        &self,
        request: tonic::Request<ExportMetricsServiceRequest>,
    ) -> Result<tonic::Response<ExportMetricsServiceResponse>, tonic::Status> {
        let hdrs = extract_grpc_metadata(request.metadata());
        let mut guard = self.received.lock().unwrap_or_else(PoisonError::into_inner);
        guard.headers.push(hdrs);
        guard.metrics.push(request.into_inner());
        Ok(tonic::Response::new(ExportMetricsServiceResponse {
            partial_success: None,
        }))
    }
}

#[tonic::async_trait]
impl LogsService for GrpcServices {
    async fn export(
        &self,
        request: tonic::Request<ExportLogsServiceRequest>,
    ) -> Result<tonic::Response<ExportLogsServiceResponse>, tonic::Status> {
        let hdrs = extract_grpc_metadata(request.metadata());
        let mut guard = self.received.lock().unwrap_or_else(PoisonError::into_inner);
        guard.headers.push(hdrs);
        guard.logs.push(request.into_inner());
        Ok(tonic::Response::new(ExportLogsServiceResponse {
            partial_success: None,
        }))
    }
}

/// Minimal `Stream` adapter over `tokio::net::TcpListener` so `libo11y-test`
/// needs no `tokio-stream` direct dependency.
struct TcpIncoming(TcpListener);

impl tonic::codegen::tokio_stream::Stream for TcpIncoming {
    type Item = io::Result<TcpStream>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.0.poll_accept(cx) {
            Poll::Ready(Ok((stream, _))) => Poll::Ready(Some(Ok(stream))),
            Poll::Ready(Err(err)) => Poll::Ready(Some(Err(err))),
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::net::TcpStream as StdTcpStream;

    use flate2::Compression;
    use flate2::write::GzEncoder;

    use super::*;

    fn send_http_post(addr: SocketAddr, path: &str, headers: &[(&str, &str)], body: &[u8]) -> u16 {
        let mut stream = StdTcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let mut head = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for (k, v) in headers {
            head.push_str(k);
            head.push_str(": ");
            head.push_str(v);
            head.push_str("\r\n");
        }
        head.push_str("\r\n");
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body);
        let _ = stream.flush();

        let mut resp = Vec::new();
        let _ = stream.read_to_end(&mut resp);
        let text = String::from_utf8_lossy(&resp);
        let status_line = text.lines().next().expect("status line");
        status_line
            .split_whitespace()
            .nth(1)
            .expect("status code")
            .parse()
            .expect("numeric status")
    }

    #[test]
    fn http_receiver_rejects_oversized_raw_and_gzip_bodies_with_413() {
        let receiver = OtlpHttpReceiver::start().expect("http receiver");

        // 1. Oversized raw body (> MAX_BODY_BYTES).
        let huge = vec![b'a'; MAX_BODY_BYTES + 1024];
        let status = send_http_post(
            receiver.addr(),
            "/v1/traces",
            &[("Content-Type", "application/x-protobuf")],
            &huge,
        );
        assert_eq!(status, 413, "oversized raw body must return 413");

        // 2. Small gzip bomb that decompresses to > MAX_BODY_BYTES.
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let chunk = vec![0u8; 64 * 1024];
        let mut written = 0;
        while written <= MAX_BODY_BYTES {
            encoder.write_all(&chunk).expect("write chunk");
            written += chunk.len();
        }
        let compressed = encoder.finish().expect("finish gzip");
        assert!(
            compressed.len() < MAX_BODY_BYTES / 10,
            "compressed payload should be small ({} bytes)",
            compressed.len()
        );
        let status = send_http_post(
            receiver.addr(),
            "/v1/traces",
            &[
                ("Content-Type", "application/x-protobuf"),
                ("Content-Encoding", "gzip"),
            ],
            &compressed,
        );
        assert_eq!(
            status, 413,
            "oversized decompressed gzip body must return 413"
        );
        assert!(receiver.traces().is_empty());
    }
}
