package o11yrum

import (
	"testing"
	"time"
)

func TestLimiterAllowsBurstThenRefills(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newLimiter(60, 10, func() time.Time { return now })
	for i := range 60 {
		if ok, _ := l.allow(1); !ok {
			t.Fatalf("request %d refused inside the burst", i)
		}
	}
	ok, wait := l.allow(1)
	if ok || wait != time.Second {
		t.Fatalf("61st: ok=%v wait=%v, want refused with 1s", ok, wait)
	}
	if ok, _ := l.allow(2); !ok {
		t.Fatal("another client was refused")
	}
	now = now.Add(time.Second)
	if ok, _ := l.allow(1); !ok {
		t.Fatal("no token after one second")
	}
}

func TestLimiterFailsOpenWhenFullOfActiveClients(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newLimiter(60, 2, func() time.Time { return now })
	l.allow(1)
	l.allow(2)
	if ok, _ := l.allow(3); !ok {
		t.Fatal("a full table must not refuse new clients")
	}
	now = now.Add(2 * time.Minute)
	l.allow(4) // sweeps the idle buckets of 1 and 2
	if got := l.tracked(); got != 1 {
		t.Fatalf("tracked %d after sweep, want 1", got)
	}
}

func TestLimiterBlockedPeeksWithoutTakingATokenFromTheBucket(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newLimiter(2, 10, func() time.Time { return now })
	if blocked, _ := l.blocked(1); blocked {
		t.Fatal("an unseen client is blocked")
	}
	if got := l.tracked(); got != 0 {
		t.Fatalf("peeking tracked %d clients, want 0", got)
	}
	l.allow(1)
	if blocked, _ := l.blocked(1); blocked {
		t.Fatal("blocked with a token left")
	}
	l.allow(1)
	for range 3 {
		blocked, wait := l.blocked(1)
		if !blocked || wait != 30*time.Second {
			t.Fatalf("empty bucket: blocked=%v wait=%v, want blocked for 30s", blocked, wait)
		}
	}
	now = now.Add(30 * time.Second)
	if blocked, _ := l.blocked(1); blocked {
		t.Fatal("still blocked once a token refilled")
	}
}
