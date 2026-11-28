package o11yrum

import (
	"sync"
	"time"
)

// limiter is a token bucket per client key, held only in memory. A full
// table first sweeps idle buckets; if it is still full, a new client is
// allowed untracked, so an address-spraying flood cannot lock out real
// clients.
type limiter struct {
	mu        sync.Mutex
	rate      float64 // tokens per second
	burst     float64
	max       int
	now       func() time.Time
	lastSweep time.Time
	sweeps    int // sweeps run, for tests
	buckets   map[uint64]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(perMinute, maxClients int, now func() time.Time) *limiter {
	return &limiter{
		rate:      float64(perMinute) / 60,
		burst:     float64(perMinute),
		max:       maxClients,
		now:       now,
		lastSweep: now(),
		buckets:   make(map[uint64]*bucket),
	}
}

// allow takes one token from key's bucket. When none is left it reports
// how long until one is.
func (l *limiter) allow(key uint64) (ok bool, retryAfter time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.lastSweep) >= time.Minute {
		l.sweepLocked(now)
	}
	b, found := l.buckets[key]
	if !found {
		// A full table is swept at most once a second, so a flood of new
		// keys cannot make every request scan the table under the lock.
		if len(l.buckets) >= l.max && now.Sub(l.lastSweep) >= time.Second {
			l.sweepLocked(now)
		}
		if len(l.buckets) >= l.max {
			return true, 0
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
}

// blocked reports whether key's bucket is empty, and how long until it
// holds a token, without taking one. An untracked key is never blocked
// and stays untracked.
func (l *limiter) blocked(key uint64) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, found := l.buckets[key]
	if !found {
		return false, 0
	}
	tokens := min(l.burst, b.tokens+l.now().Sub(b.last).Seconds()*l.rate)
	if tokens >= 1 {
		return false, 0
	}
	return true, time.Duration((1 - tokens) / l.rate * float64(time.Second))
}

// sweepLocked drops buckets idle long enough to have refilled completely.
func (l *limiter) sweepLocked(now time.Time) {
	full := time.Duration(l.burst / l.rate * float64(time.Second))
	for k, b := range l.buckets {
		if now.Sub(b.last) >= full {
			delete(l.buckets, k)
		}
	}
	l.lastSweep = now
	l.sweeps++
}

// tracked reports how many clients have a bucket. Tests only.
func (l *limiter) tracked() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
