// Package s3store keeps o11yrum objects (source maps) in Amazon S3 or an
// S3-compatible store.
//
// New authenticates with the AWS SDK's default credential chain, which
// covers EKS Pod Identity, IRSA, instance roles, shared configuration
// files and environment credentials, so no static key is needed on EKS.
package s3store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/jamesainslie/libo11y/go/o11yrum"
)

// Config locates the bucket. Only Bucket is required.
type Config struct {
	// Bucket is the bucket objects are kept in.
	Bucket string `yaml:"bucket"`
	// Prefix is prepended to every object key, as given: end it with a
	// slash to keep the objects under a folder.
	Prefix string `yaml:"prefix"`
	// Region overrides the region the default chain finds
	// (AWS_REGION, the shared configuration, or instance metadata).
	Region string `yaml:"region"`
	// Endpoint points the client at an S3-compatible store instead of
	// Amazon S3.
	Endpoint string `yaml:"endpoint"`
	// UsePathStyle addresses buckets as https://endpoint/bucket/key, as
	// most S3-compatible stores need.
	UsePathStyle bool `yaml:"use_path_style"`
}

// Store is an o11yrum.ObjectStore backed by one S3 bucket.
type Store struct {
	client *s3.Client
	bucket string
	prefix string
}

var _ o11yrum.ObjectStore = (*Store)(nil)

// New builds a store with credentials from the AWS SDK's default chain.
// It makes no request, so a missing permission shows on first use.
func New(ctx context.Context, cfg Config) (*Store, error) {
	if cfg.Bucket == "" {
		return nil, errors.New("s3store: bucket is empty")
	}
	var opts []func(*config.LoadOptions) error
	if cfg.Region != "" {
		opts = append(opts, config.WithRegion(cfg.Region))
	}
	awsCfg, err := config.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("s3store: %w", err)
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.UsePathStyle = cfg.UsePathStyle
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
		// Checksums only where the API requires them keep S3-compatible
		// stores that do not understand aws-chunked bodies working.
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	return NewWithClient(client, cfg.Bucket, cfg.Prefix), nil
}

// NewWithClient builds a store on a client the caller configured.
func NewWithClient(client *s3.Client, bucket, prefix string) *Store {
	return &Store{client: client, bucket: bucket, prefix: prefix}
}

// Put stores data under the prefixed key.
func (s *Store) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(s.prefix + key),
		Body:          bytes.NewReader(data),
		ContentLength: aws.Int64(int64(len(data))),
		ContentType:   aws.String("application/json"),
	})
	if err != nil {
		return fmt.Errorf("s3store: put %s: %w", key, err)
	}
	return nil
}

// Get reads the prefixed key, returning o11yrum.ErrNotFound when the
// bucket has no such object.
func (s *Store) Get(ctx context.Context, key string) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.prefix + key),
	})
	if err != nil {
		if _, ok := errors.AsType[*types.NoSuchKey](err); ok {
			return nil, o11yrum.ErrNotFound
		}
		return nil, fmt.Errorf("s3store: get %s: %w", key, err)
	}
	defer func() { _ = out.Body.Close() }()
	b, err := io.ReadAll(out.Body)
	if err != nil {
		return nil, fmt.Errorf("s3store: get %s: %w", key, err)
	}
	return b, nil
}
