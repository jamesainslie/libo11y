package o11yrum

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrNotFound is what ObjectStore.Get returns for a key it does not hold.
var ErrNotFound = errors.New("o11yrum: object not found")

// ObjectStore holds the gateway's objects, which are source maps. Keys are
// slash-separated relative paths built by the gateway. Implementations
// must be safe for concurrent use.
type ObjectStore interface {
	// Put stores data under key, replacing any object already there.
	Put(ctx context.Context, key string, data []byte) error
	// Get returns the object under key, or ErrNotFound when there is none.
	Get(ctx context.Context, key string) ([]byte, error)
}

// segmentPattern is what one caller-chosen key segment may hold: a
// namespace, a service.version or an update ID. It cannot be "." or "..",
// cannot hold a slash, and fits a file name and an S3 key.
var segmentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)

// validSegment reports whether s may be used as a key segment.
func validSegment(s string) bool { return segmentPattern.MatchString(s) }

// normalizeScriptPath reduces a script URL to the path its source map is
// stored under: scheme, host, query and fragment are removed, escapes are
// decoded, and the path is cleaned and made absolute. One upload therefore
// serves every origin the script is served from, and works for
// chrome-extension:// and app:/// URLs alike. A "~/" prefix, as upload
// tools use for the site root, means "/".
func normalizeScriptPath(raw string) string {
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "~/") {
		raw = raw[1:]
	}
	if u, err := url.Parse(raw); err == nil {
		if u.Opaque != "" {
			raw = u.Opaque
		} else {
			raw = u.Path
		}
	} else {
		raw, _, _ = strings.Cut(raw, "#")
		raw, _, _ = strings.Cut(raw, "?")
	}
	if !strings.HasPrefix(raw, "/") {
		raw = "/" + raw
	}
	return path.Clean(raw)
}

// sourcemapKey is the object key of the source map for one script of one
// release. The script path is hashed so the key has a fixed shape whatever
// characters the path holds.
func sourcemapKey(namespace, version, updateID, scriptPath string) string {
	if updateID == "" {
		updateID = "_"
	}
	sum := sha256.Sum256([]byte(scriptPath))
	return "sourcemaps/" + namespace + "/" + version + "/" + updateID + "/" + hex.EncodeToString(sum[:16]) + ".map"
}

// FileStore keeps objects as files under a root directory.
type FileStore struct{ root string }

// NewFileStore returns a store rooted at root, creating the directory when
// it does not exist.
func NewFileStore(root string) (*FileStore, error) {
	if root == "" {
		return nil, errors.New("o11yrum: file store: root is empty")
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("o11yrum: file store: %w", err)
	}
	return &FileStore{root: root}, nil
}

// path maps a key to its file, refusing any key that could leave the root.
func (s *FileStore) path(key string) (string, error) {
	if !fs.ValidPath(key) || key == "." || strings.Contains(key, `\`) {
		return "", fmt.Errorf("o11yrum: file store: invalid key %q", key)
	}
	return filepath.Join(s.root, filepath.FromSlash(key)), nil
}

// Put writes data to a temporary file beside the object and renames it
// into place, so a reader never sees a partial object.
func (s *FileStore) Put(_ context.Context, key string, data []byte) (err error) {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		return fmt.Errorf("o11yrum: file store: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".put-*")
	if err != nil {
		return fmt.Errorf("o11yrum: file store: %w", err)
	}
	defer func() {
		if err != nil {
			_ = os.Remove(tmp.Name())
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("o11yrum: file store: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("o11yrum: file store: %w", err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return fmt.Errorf("o11yrum: file store: %w", err)
	}
	return nil
}

// Get reads the object under key.
func (s *FileStore) Get(_ context.Context, key string) ([]byte, error) {
	p, err := s.path(key)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("o11yrum: file store: %w", err)
	}
	return b, nil
}
