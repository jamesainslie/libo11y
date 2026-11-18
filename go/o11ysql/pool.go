package o11ysql

import (
	"context"
	"database/sql"
	"fmt"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
)

// RegisterPoolMetrics reports db's connection pool from sql.DB.Stats at
// every collection: db.client.connection.count by db.client.connection.state
// (idle, used) and db.client.connection.max (omitted while the pool is
// unlimited), each with db.client.connection.pool.name (see
// [WithPoolName]). Call Unregister on the result when db is closed.
func RegisterPoolMetrics(db *sql.DB, opts ...Option) (metric.Registration, error) {
	return registerPoolMetrics(db, newConfig("", opts))
}

func registerPoolMetrics(db *sql.DB, cfg *config) (metric.Registration, error) {
	_, mp := providers(cfg)
	meter := mp.Meter(scopeName)
	count, err := meter.Int64ObservableUpDownCounter("db.client.connection.count",
		metric.WithUnit("{connection}"),
		metric.WithDescription("The number of connections that are currently in state described by the `state` attribute."),
	)
	if err != nil {
		return nil, fmt.Errorf("o11ysql: creating db.client.connection.count: %w", err)
	}
	maxOpen, err := meter.Int64ObservableUpDownCounter("db.client.connection.max",
		metric.WithUnit("{connection}"),
		metric.WithDescription("The maximum number of open connections allowed."),
	)
	if err != nil {
		return nil, fmt.Errorf("o11ysql: creating db.client.connection.max: %w", err)
	}
	name := cfg.poolName
	if name == "" {
		name = cfg.system
	}
	pool := semconv.DBClientConnectionPoolName(name)
	idle := metric.WithAttributeSet(attribute.NewSet(pool, semconv.DBClientConnectionStateIdle))
	used := metric.WithAttributeSet(attribute.NewSet(pool, semconv.DBClientConnectionStateUsed))
	poolOnly := metric.WithAttributeSet(attribute.NewSet(pool))
	reg, err := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		stats := db.Stats()
		o.ObserveInt64(count, int64(stats.Idle), idle)
		o.ObserveInt64(count, int64(stats.InUse), used)
		if stats.MaxOpenConnections > 0 {
			o.ObserveInt64(maxOpen, int64(stats.MaxOpenConnections), poolOnly)
		}
		return nil
	}, count, maxOpen)
	if err != nil {
		return nil, fmt.Errorf("o11ysql: registering pool metrics: %w", err)
	}
	return reg, nil
}
