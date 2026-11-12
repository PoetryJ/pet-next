# R5 saved checkpoint — 2026-11-12

**Verdict: limited rework; saved and paused at the owner's request.**

Source commit: `ff7e1b82c70fae098dc93abc8a1c9bac46fac592`. This archive commit adds review material only. The experimental source is unchanged. No product activation, merge to main, model call, or next-round task was performed.

G0 identity scoring passes. Real-clock automatic continuation, future waking, restart across an overdue job, cancellation and stale-state suppression are demonstrated on Linux and Windows. The independent service probe has 26 passing functional assertions and one failing logical-job deduplication assertion on each platform.

Windows is not fully accepted: the original R5 demo fails its SIGTERM stop assertion, and the R5 negative-control harness fails to import before any of its six cases runs. N1 and P3 are tied on the frozen 12-story comparison; less interruption has not been proved.

Read [REVIEW.txt](REVIEW.txt), [EXPERIMENTS.json](EXPERIMENTS.json), [ENVIRONMENT.json](ENVIRONMENT.json), and [REPRO.txt](REPRO.txt). [STATUS.json](STATUS.json) records the pause and remaining limitations. Evidence archives preserve both failures and successes. [SHA256SUMS.txt](SHA256SUMS.txt) covers this checkpoint's files except itself.

The source branch contains the previous unpublished experiment history as well as R5. This does not approve every previous commit or turn experiments into defaults. All 193 pre-archive commits missing from the previously published preview are retained. Main remains unchanged.
