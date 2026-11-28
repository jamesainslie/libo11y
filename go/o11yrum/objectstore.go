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
	"slices"
	"strings"
	"time"
)

// ErrNotFound is what ObjectStore.Get returns for a key it does not hold.
var ErrNotFound = errors.New("o11yrum: object not found")

// ObjectStore holds the gateway's objects: source maps and session replay
// segments. Keys are
// slash-separated relative paths built by the gateway. Implementations
// must be safe for concurrent use.
type ObjectStore interface {
	// Put stores data under key, replacing any object already there.
	Put(ctx context.Context, key string, data []byte) error
	// Get returns the object under key, or ErrNotFound when there is none.
	Get(ctx context.Context, key string) ([]byte, error)
}

// ObjectInfo describes one stored object.
type ObjectInfo struct {
	// Key is the object's key, as Put was given it.
	Key string
	// Size is the object's length in bytes.
	Size int64
	// Modified is when the object was last written.
	Modified time.Time
}

// ObjectLister is an ObjectStore that can list its objects. Session
// replay needs it, for the read API and retention. Implementations must
// be safe for concurrent use.
type ObjectLister interface {
	// List calls fn for every object whose key starts with prefix, in key
	// order. An error from fn stops the listing and is returned.
	List(ctx context.Context, prefix string, fn func(ObjectInfo) error) error
}

// ObjectDeleter is an ObjectStore that can delete objects. Session replay
// needs it, for erasure and retention. Implementations must be safe for
// concurrent use.
type ObjectDeleter interface {
	// Delete removes key. A missing key is not an error.
	Delete(ctx context.Context, key string) error
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

// tempPrefix starts the name of the temporary file Put writes beside an
// object. List skips such files: they are not objects yet.
const tempPrefix = ".put-"

// List calls fn for every object whose key starts with prefix, in key
// order. prefix follows the key rules of Put, except that it may be empty
// or end with a slash, and may end part way through a key segment.
func (s *FileStore) List(ctx context.Context, prefix string, fn func(ObjectInfo) error) error {
	dir := ""
	if prefix != "" {
		trimmed := strings.TrimSuffix(prefix, "/")
		if !fs.ValidPath(trimmed) || trimmed == "." || strings.Contains(prefix, `\`) {
			return fmt.Errorf("o11yrum: file store: invalid prefix %q", prefix)
		}
		dir = trimmed
		if !strings.HasSuffix(prefix, "/") {
			if dir = path.Dir(trimmed); dir == "." {
				dir = ""
			}
		}
	}
	if err := s.walk(ctx, dir, prefix, fn); !errors.Is(err, errDirGone) {
		return err
	}
	return nil // no directory, so no objects
}

// errDirGone is what walk returns for a directory that does not exist,
// which holds no objects.
var errDirGone = errors.New("directory does not exist")

// walk lists the objects under the directory of key dir ("" for the root)
// whose keys start with prefix. Entries are visited in key order: a
// directory sorts as its name followed by "/", which is not the order
// os.ReadDir returns.
func (s *FileStore) walk(ctx context.Context, dir, prefix string, fn func(ObjectInfo) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := os.ReadDir(filepath.Join(s.root, filepath.FromSlash(dir)))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return errDirGone
		}
		return fmt.Errorf("o11yrum: file store: %w", err)
	}
	type entry struct {
		key   string
		isDir bool
		e     fs.DirEntry
	}
	list := make([]entry, 0, len(entries))
	for _, e := range entries {
		key := e.Name()
		if dir != "" {
			key = dir + "/" + key
		}
		switch {
		case e.IsDir():
			// Descend only where keys under the directory can match.
			if d := key + "/"; strings.HasPrefix(d, prefix) || strings.HasPrefix(prefix, d) {
				list = append(list, entry{key: d, isDir: true, e: e})
			}
		case e.Type().IsRegular() && !strings.HasPrefix(e.Name(), tempPrefix) && strings.HasPrefix(key, prefix):
			list = append(list, entry{key: key, e: e})
		}
	}
	slices.SortFunc(list, func(a, b entry) int { return strings.Compare(a.key, b.key) })
	for _, en := range list {
		if en.isDir {
			if err := s.walk(ctx, strings.TrimSuffix(en.key, "/"), prefix, fn); err != nil && !errors.Is(err, errDirGone) {
				return err
			}
			continue
		}
		info, err := en.e.Info()
		if errors.Is(err, fs.ErrNotExist) {
			continue // deleted since the directory was read
		}
		if err != nil {
			return fmt.Errorf("o11yrum: file store: %w", err)
		}
		if err := fn(ObjectInfo{Key: en.key, Size: info.Size(), Modified: info.ModTime()}); err != nil {
			return err
		}
	}
	return nil
}

// Delete removes the object under key. A missing key is not an error.
// Directories the deletion leaves empty stay: Put recreates them anyway.
func (s *FileStore) Delete(_ context.Context, key string) error {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("o11yrum: file store: %w", err)
	}
	return nil
}
