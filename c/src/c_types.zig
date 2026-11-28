//! C11 ABI type definitions matching `c/include/o11y/spec.h`,
//! `c/include/o11y/o11y.h`, and `c/include/o11y/test.h` field for field.

pub const Sensitivity = enum(c_int) {
    unclassified = 0,
    public = 1,
    internal = 2,
    pii = 3,
    secret = 4,
};

pub const Cardinality = enum(c_int) {
    unclassified = 0,
    @"enum" = 1,
    bounded = 2,
    unbounded = 3,
};

pub const Err = enum(c_int) {
    ok = 0,
    already_setup = 1,
    no_service_name = 2,
    no_environment = 3,
    invalid_environment = 4,
    pii_hash_key = 5,
    invalid_app_registry = 6,
    canary_rejected = 7,
    unsupported_protocol = 8,
    exporter = 9,
    out_of_memory = 10,
    invalid_argument = 11,
    invalid_carrier = 12,
    timeout = 13,
    shutdown = 14,
    io = 15,
    unsupported_propagator = 16,
    _,
};

pub const Diagnostic = extern struct {
    message: [1024]u8 = @splat(0),
    len: usize = 0,
};

pub const TraceId = extern struct {
    bytes: [16]u8 = @splat(0),
};

pub const SpanId = extern struct {
    bytes: [8]u8 = @splat(0),
};

pub const SpanContext = extern struct {
    trace_id: TraceId = .{},
    span_id: SpanId = .{},
    trace_flags: u8 = 0,
    remote: bool = false,
    trace_state: ?[*:0]const u8 = null,
};

pub const AttrKind = enum(c_int) {
    string = 0,
    bool = 1,
    int = 2,
    double = 3,
    string_array = 4,
    bool_array = 5,
    int_array = 6,
    double_array = 7,
    _,
};

pub const StrArray = extern struct {
    items: ?[*]const ?[*:0]const u8,
    len: usize,
};

pub const BoolArray = extern struct {
    items: ?[*]const bool,
    len: usize,
};

pub const IntArray = extern struct {
    items: ?[*]const i64,
    len: usize,
};

pub const DoubleArray = extern struct {
    items: ?[*]const f64,
    len: usize,
};

pub const AttrValue = extern union {
    str_val: ?[*:0]const u8,
    bool_val: bool,
    int_val: i64,
    double_val: f64,
    str_array: StrArray,
    bool_array: BoolArray,
    int_array: IntArray,
    double_array: DoubleArray,
};

pub const Attr = extern struct {
    key: ?[*:0]const u8,
    kind: AttrKind,
    value: AttrValue,
};

pub const LogValueKind = enum(c_int) {
    empty = 0,
    string = 1,
    bool = 2,
    int = 3,
    double = 4,
    bytes = 5,
    array = 6,
    map = 7,
    _,
};

pub const LogStrVal = extern struct {
    data: ?[*]const u8,
    len: usize,
    has_len: bool,
};

pub const LogBytesVal = extern struct {
    data: ?[*]const u8,
    len: usize,
};

pub const LogArrayVal = extern struct {
    items: ?[*]const LogValue,
    len: usize,
};

pub const LogMapVal = extern struct {
    items: ?[*]const LogAttr,
    len: usize,
};

pub const LogValueUnion = extern union {
    str_val: LogStrVal,
    bool_val: bool,
    int_val: i64,
    double_val: f64,
    bytes_val: LogBytesVal,
    array_val: LogArrayVal,
    map_val: LogMapVal,
};

pub const LogValue = extern struct {
    kind: LogValueKind,
    value: LogValueUnion,
};

pub const LogAttr = extern struct {
    key: ?[*:0]const u8,
    value: LogValue,
};

pub const EnvMode = enum(c_int) {
    process = 0,
    hermetic = 1,
    pairs = 2,
    entries = 3,
    _,
};

pub const EnvPair = extern struct {
    key: ?[*:0]const u8,
    value: ?[*:0]const u8,
};

pub const Protocol = enum(c_int) {
    default = 0,
    http_protobuf = 1,
    http_json = 2,
    grpc = 3,
    _,
};

pub const Level = enum(c_int) {
    debug = 0,
    info = 1,
    warn = 2,
    err = 3,
    _,
};

pub const ConsoleFormat = enum(c_int) {
    json = 0,
    text = 1,
    _,
};

pub const ConsoleTarget = enum(c_int) {
    stdout = 0,
    stderr = 1,
    custom = 2,
    _,
};

pub const ConsoleWriteFn = *const fn (userdata: ?*anyopaque, bytes: [*]const u8, len: usize) callconv(.c) Err;

pub const PiiMode = enum(c_int) {
    drop = 0,
    hash = 1,
    allow = 2,
    _,
};

pub const SamplerKind = enum(c_int) {
    default = 0,
    always_on = 1,
    always_off = 2,
    trace_id_ratio = 3,
    parent_based_always_on = 4,
    parent_based_always_off = 5,
    parent_based_trace_id_ratio = 6,
    _,
};

pub const ExemplarFilter = enum(c_int) {
    default = 0,
    trace_based = 1,
    always_on = 2,
    always_off = 3,
    _,
};

pub const BuildInfo = extern struct {
    enabled: bool = false,
    version: ?[*:0]const u8 = null,
    revision: ?[*:0]const u8 = null,
    time: ?[*:0]const u8 = null,
    modified_set: bool = false,
    modified: bool = false,
};

pub const AppRegistrySource = extern struct {
    file_path: ?[*:0]const u8,
    content: ?[*]const u8,
    content_len: usize,
};

pub const HistogramBuckets = extern struct {
    instrument_name: ?[*:0]const u8,
    boundaries: ?[*]const f64,
    boundaries_len: usize,
};

pub const AttrReplacerFn = *const fn (
    userdata: ?*anyopaque,
    groups: ?[*]const ?[*:0]const u8,
    groups_len: usize,
    key: [*:0]const u8,
    value: *const LogValue,
    out_key_buf: [*]u8,
    out_key_cap: usize,
    out_str_val_buf: [*]u8,
    out_str_val_cap: usize,
    out_val: *LogValue,
    out_replace_val: *bool,
) callconv(.c) bool;

pub const LogSink = extern struct {
    userdata: ?*anyopaque,
    enabled: ?*const fn (userdata: ?*anyopaque, level: Level, force_emit: bool) callconv(.c) bool,
    emit: ?*const fn (
        userdata: ?*anyopaque,
        time_unix_nano: u64,
        level: Level,
        message: [*:0]const u8,
        span_context: SpanContext,
        attrs: ?[*]const LogAttr,
        attrs_len: usize,
    ) callconv(.c) Err,
};

pub const BaggageEgressAllowFn = *const fn (userdata: ?*anyopaque, key: [*:0]const u8) callconv(.c) bool;
pub const ErrorHandlerFn = *const fn (userdata: ?*anyopaque, message: [*:0]const u8) callconv(.c) void;

pub const PropagatorKind = enum(c_int) {
    trace_context = 0,
    baggage = 1,
    custom = 2,
    _,
};

/// `ctx` and the result of extract are `o11y_ctx_t` handles.
pub const PropagatorInjectFn = *const fn (userdata: ?*anyopaque, ctx: ?*const anyopaque, carrier: *const Carrier) callconv(.c) void;
pub const PropagatorExtractFn = *const fn (userdata: ?*anyopaque, parent: ?*const anyopaque, carrier: *const Carrier) callconv(.c) ?*anyopaque;

pub const Propagator = extern struct {
    kind: PropagatorKind = .trace_context,
    userdata: ?*anyopaque = null,
    inject: ?PropagatorInjectFn = null,
    extract: ?PropagatorExtractFn = null,
    fields: ?[*]const ?[*:0]const u8 = null,
    fields_len: usize = 0,
};

pub const Options = extern struct {
    struct_size: usize = @sizeOf(Options),
    env_mode: EnvMode = .process,
    env_pairs: ?[*]const EnvPair = null,
    env_pairs_len: usize = 0,
    env_entries: ?[*]const ?[*:0]const u8 = null,
    env_entries_len: usize = 0,

    protocol: Protocol = .default,

    service_name: ?[*:0]const u8 = null,
    service_version: ?[*:0]const u8 = null,
    service_namespace: ?[*:0]const u8 = null,
    environment: ?[*:0]const u8 = null,
    extra_environments: ?[*]const ?[*:0]const u8 = null,
    extra_environments_len: usize = 0,
    strict_identity: bool = true,

    resource_attributes: ?[*]const Attr = null,
    resource_attributes_len: usize = 0,

    build_info: BuildInfo = .{},

    log_level: Level = .info,
    console_enabled: bool = true,
    console_format: ConsoleFormat = .json,
    console_target: ConsoleTarget = .stdout,
    console_write_fn: ?ConsoleWriteFn = null,
    console_write_userdata: ?*anyopaque = null,
    log_export: bool = true,

    attr_replacer_fn: ?AttrReplacerFn = null,
    attr_replacer_userdata: ?*anyopaque = null,
    extra_log_sinks: ?[*]const LogSink = null,
    extra_log_sinks_len: usize = 0,

    pii_mode: PiiMode = .drop,
    pii_hash_key: ?[*]const u8 = null,
    pii_hash_key_len: usize = 0,

    app_registries: ?[*]const AppRegistrySource = null,
    app_registries_len: usize = 0,

    sampler_kind: SamplerKind = .default,
    sampler_ratio: f64 = 1.0,

    propagators: ?[*]const Propagator = null,
    propagators_len: usize = 0,
    baggage_egress_allow: ?BaggageEgressAllowFn = null,
    baggage_egress_allow_userdata: ?*anyopaque = null,

    histogram_buckets: ?[*]const HistogramBuckets = null,
    histogram_buckets_len: usize = 0,
    exemplar_filter: ExemplarFilter = .default,

    runtime_metrics: bool = true,
    startup_summary: bool = true,

    error_handler_fn: ?ErrorHandlerFn = null,
    error_handler_userdata: ?*anyopaque = null,
};

pub const ShutdownReport = extern struct {
    logs: Err = .ok,
    metrics: Err = .ok,
    traces: Err = .ok,
};

pub const SignalOptions = extern struct {
    timeout_ms: u64 = 0,
    before_shutdown: ?*const fn (userdata: ?*anyopaque) callconv(.c) void = null,
    before_shutdown_userdata: ?*anyopaque = null,
    signals: ?[*]const c_int = null,
    signals_len: usize = 0,
};

pub const SpanKind = enum(c_int) {
    internal = 1,
    server = 2,
    client = 3,
    producer = 4,
    consumer = 5,
    _,
};

pub const StatusCode = enum(c_int) {
    unset = 0,
    err = 1,
    ok = 2,
    _,
};

pub const SpanLink = extern struct {
    span_context: SpanContext,
    attributes: ?[*]const Attr,
    attributes_len: usize,
};

pub const SpanStartOptions = extern struct {
    kind: SpanKind = .internal,
    attributes: ?[*]const Attr = null,
    attributes_len: usize = 0,
    links: ?[*]const SpanLink = null,
    links_len: usize = 0,
    start_time_unix_nano: u64 = 0,
    new_root: bool = false,
};

pub const InstrumentOptions = extern struct {
    description: ?[*:0]const u8 = null,
    unit: ?[*:0]const u8 = null,
};

pub const HistogramOptions = extern struct {
    description: ?[*:0]const u8 = null,
    unit: ?[*:0]const u8 = null,
    explicit_bucket_boundaries: ?[*]const f64 = null,
    explicit_bucket_boundaries_len: usize = 0,
};

pub const InstHandle = extern struct {
    impl: ?*anyopaque = null,
};

pub const ObserveI64Fn = *const fn (userdata: ?*anyopaque, obs: ?*anyopaque) callconv(.c) void;
pub const ObserveF64Fn = *const fn (userdata: ?*anyopaque, obs: ?*anyopaque) callconv(.c) void;

pub const Carrier = extern struct {
    userdata: ?*anyopaque,
    get: ?*const fn (userdata: ?*anyopaque, key: [*:0]const u8) callconv(.c) ?[*:0]const u8,
    set: ?*const fn (userdata: ?*anyopaque, key: [*:0]const u8, value: [*:0]const u8) callconv(.c) void,
};

// Test harness types (matching c/include/o11y/test.h)

pub const TestOptions = extern struct {
    struct_size: usize = @sizeOf(TestOptions),
    service_name: ?[*:0]const u8 = "test-service",
    service_version: ?[*:0]const u8 = null,
    service_namespace: ?[*:0]const u8 = null,
    environment: ?[*:0]const u8 = "test",
    extra_environments: ?[*]const ?[*:0]const u8 = null,
    extra_environments_len: usize = 0,
    strict_identity: bool = true,

    resource_attributes: ?[*]const Attr = null,
    resource_attributes_len: usize = 0,

    build_info: BuildInfo = .{},

    log_level: Level = .debug,
    console_enabled: bool = true,
    console_format: ConsoleFormat = .json,
    log_export: bool = true,

    attr_replacer_fn: ?AttrReplacerFn = null,
    attr_replacer_userdata: ?*anyopaque = null,
    extra_log_sinks: ?[*]const LogSink = null,
    extra_log_sinks_len: usize = 0,

    pii_mode: PiiMode = .drop,
    pii_hash_key: ?[*]const u8 = null,
    pii_hash_key_len: usize = 0,

    app_registries: ?[*]const AppRegistrySource = null,
    app_registries_len: usize = 0,

    sampler_kind: SamplerKind = .always_on,
    sampler_ratio: f64 = 1.0,

    propagators: ?[*]const Propagator = null,
    propagators_len: usize = 0,
    baggage_egress_allow: ?BaggageEgressAllowFn = null,
    baggage_egress_allow_userdata: ?*anyopaque = null,

    histogram_buckets: ?[*]const HistogramBuckets = null,
    histogram_buckets_len: usize = 0,
    exemplar_filter: ExemplarFilter = .trace_based,

    runtime_metrics: bool = false,
};

pub const TestExemplar = extern struct {
    trace_id: TraceId = .{},
    span_id: SpanId = .{},
    value: f64 = 0,
    time_unix_nano: u64 = 0,
};

pub const TestTlsOptions = extern struct {
    enabled: bool = false,
    cert_pem: ?[*:0]const u8 = null,
    key_pem: ?[*:0]const u8 = null,
    client_ca_pem: ?[*:0]const u8 = null,
};

pub const TestHttpReply = extern struct {
    status: u16 = 200,
    retry_after: ?[*:0]const u8 = null,
    body: ?[*]const u8 = null,
    body_len: usize = 0,
    content_type: ?[*:0]const u8 = null,
    delay_ms: u64 = 0,
    hang: bool = false,
    close_after: bool = false,
};

pub const TestHttpReceiverOptions = extern struct {
    replies: ?[*]const TestHttpReply = null,
    replies_len: usize = 0,
    tls: TestTlsOptions = .{},
};

pub const TestGrpcReply = extern struct {
    http_status: u16 = 200,
    grpc_status: u32 = 0,
    grpc_message: ?[*:0]const u8 = null,
    delay_ms: u64 = 0,
    hang: bool = false,
};

pub const TestGrpcReceiverOptions = extern struct {
    replies: ?[*]const TestGrpcReply = null,
    replies_len: usize = 0,
    tls: TestTlsOptions = .{},
};
