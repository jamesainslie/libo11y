package o11yrum

import (
	"context"
	"log/slog"
	"time"
)

// replayRoot is the key prefix of every recording.
const replayRoot = "replay/"

// startSweeper runs a retention pass every replay.sweep_interval until
// Close. The first pass runs one interval after start, so a fleet that
// restarts together does not sweep in a burst. Several replicas sweeping
// at once is harmless: deleting a missing object is not an error.
func (h *Handler) startSweeper(every time.Duration) {
	ctx, stop := context.WithCancel(context.Background())
	h.sweepStop = stop
	h.sweepDone.Add(1)
	go func() {
		defer h.sweepDone.Done()
		tick := time.NewTicker(every)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				h.sweepOnce(ctx)
			}
		}
	}()
}

// sweepOnce runs one pass and logs a pass that could not finish.
func (h *Handler) sweepOnce(ctx context.Context) {
	if _, err := h.sweepReplay(ctx); err != nil && ctx.Err() == nil {
		h.log.WarnContext(ctx, "o11yrum: replay retention sweep ended early", slog.Any("error", err))
	}
}

// sweepReplay is one retention pass. It lists every replay object and
// deletes those last written longer ago than replay.retention, returning
// how many it deleted. A failed Delete is counted and the pass goes on; a
// failed List ends the pass and is returned. Keys are never logged: they
// hold session IDs.
func (h *Handler) sweepReplay(ctx context.Context) (deleted int, err error) {
	cutoff := h.now().Add(-h.cfg.Replay.Retention)
	failed := 0
	err = h.listReplay(ctx, replayRoot, func(o ObjectInfo) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if o.Modified.After(cutoff) {
			return nil
		}
		if err := h.deleteReplay(ctx, o.Key); err != nil {
			failed++
			return nil
		}
		deleted++
		return nil
	})
	h.tel.replaySwept(ctx, sinkOK, int64(deleted))
	h.tel.replaySwept(ctx, sinkError, int64(failed))
	if failed > 0 {
		h.log.WarnContext(ctx, "o11yrum: replay retention sweep could not delete some objects",
			slog.Int("o11yrum.deleted", deleted), slog.Int("o11yrum.failed", failed))
	}
	return deleted, err
}
