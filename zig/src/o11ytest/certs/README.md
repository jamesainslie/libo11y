# TLS test fixtures

These PEM files are test fixtures for `../test_certs.zig`, the in-process
OTLP/HTTP receiver (`../http_receiver.zig`), the OTLP/gRPC receiver
(`../grpc_receiver.zig`), and the wire tests (`../wire_test.zig`). They are
not secrets and protect nothing.

| File | What it is |
|---|---|
| `ca.pem` | The test CA (`libo11y test CA`). It signs the server and client certificates. |
| `other-ca.pem` | An unrelated CA (`libo11y other test CA`), for the wrong-CA test. |
| `server.pem`, `server-key.pem` | The server certificate for `localhost` and `127.0.0.1`, with server auth usage, and its key. |
| `client.pem`, `client-key.pem` | The client certificate (`libo11y test client`), with client auth usage, and its key. |

Every key is ECDSA P-256 in PKCS#8 form. Every certificate is valid from
2026-01-01 for 100 years, so the fixtures do not expire. The CA keys are
not kept: regenerating replaces every file.

## Regenerating

openssl is not needed. Save the program below as `main.go` in an empty
temporary directory, with this `go.mod`:

```
module certgen

go 1.26
```

Then run it from that directory, naming this directory as the output:

```sh
go run . <repo>/zig/src/o11ytest/certs
```

The program:

```go
// Command certgen writes the TLS test fixtures for the libo11y Zig OTLP
// transport tests: two CAs, a server certificate for localhost and
// 127.0.0.1, a client certificate, and their keys. Every key is ECDSA
// P-256 and every certificate is valid for 100 years.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

var (
	notBefore = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	notAfter  = notBefore.AddDate(100, 0, 0)
)

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: certgen OUTDIR")
	}
	out := os.Args[1]

	ca, caKey := newCA(out, "ca", "libo11y test CA", 1)
	newCA(out, "other-ca", "libo11y other test CA", 2)

	leaf(out, "server", &x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}, ca, caKey)
	leaf(out, "client", &x509.Certificate{
		SerialNumber: big.NewInt(4),
		Subject:      pkix.Name{CommonName: "libo11y test client"},
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}, ca, caKey)
}

func newCA(out, name, cn string, serial int64) (*x509.Certificate, *ecdsa.PrivateKey) {
	key := newKey()
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(serial),
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	writePEM(out, name+".pem", "CERTIFICATE", der)
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		log.Fatal(err)
	}
	return cert, key
}

func leaf(out, name string, tmpl *x509.Certificate, ca *x509.Certificate, caKey *ecdsa.PrivateKey) {
	key := newKey()
	tmpl.NotBefore = notBefore
	tmpl.NotAfter = notAfter
	tmpl.KeyUsage = x509.KeyUsageDigitalSignature
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		log.Fatal(err)
	}
	writePEM(out, name+".pem", "CERTIFICATE", der)
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		log.Fatal(err)
	}
	writePEM(out, name+"-key.pem", "PRIVATE KEY", keyDER)
}

func newKey() *ecdsa.PrivateKey {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	return key
}

func writePEM(out, name, typ string, der []byte) {
	data := pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der})
	if err := os.WriteFile(filepath.Join(out, name), data, 0o644); err != nil {
		log.Fatal(err)
	}
}
```
