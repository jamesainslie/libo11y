#!/usr/bin/env bash
# run_sanitized.sh: compile every C11 test suite and the quickstart with the
# host C compiler under AddressSanitizer (with leak detection) and
# UndefinedBehaviorSanitizer, link them against installed libo11y.a and
# libo11ytest.a, and run them.
#
# libo11y allocates with libc malloc, so the sanitizer runtime sees every
# allocation the library makes: a leak or a double free inside the library
# fails the run, as does undefined behaviour in the C headers and tests.
#
# Usage: run_sanitized.sh PREFIX [CONFORMANCE_DIR]
#   PREFIX           an install prefix produced by `zig build --prefix PREFIX`
#   CONFORMANCE_DIR  the shared conformance directory (default: ../conformance)
#
# Environment: CC (default cc), C_SANITIZE_J (parallel compiles, default 4).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${1:?usage: run_sanitized.sh PREFIX [CONFORMANCE_DIR]}"
conformance_dir="${2:-$root/../conformance}"
cc="${CC:-cc}"
jobs="${C_SANITIZE_J:-4}"

for rel in include/o11y/o11y.h include/o11y/test.h lib/libo11y.a lib/libo11ytest.a; do
	if [[ ! -f "$prefix/$rel" ]]; then
		echo "run_sanitized: $prefix/$rel is missing; run zig build --prefix first" >&2
		exit 1
	fi
done

out="$(mktemp -d)"
cleanup() {
	rm -rf -- "$out"
}
trap cleanup EXIT

flags=(
	-std=c11 -g -O1 -Wall -Wextra -Werror -Wpedantic
	-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer
	-I"$prefix/include" -I"$root/tests"
)

compile() {
	local src="$1"
	local name
	name="$(basename "$src" .c)"
	if [[ "$name" == "quickstart" ]]; then
		"$cc" "${flags[@]}" "$src" "$prefix/lib/libo11y.a" -lpthread -lm -o "$out/$name"
	else
		"$cc" "${flags[@]}" "$src" "$prefix/lib/libo11ytest.a" "$prefix/lib/libo11y.a" -lpthread -lm -o "$out/$name"
	fi
}

sources=("$root"/tests/test_*.c "$root/examples/quickstart.c")
pids=()
wait_batch() {
	local rc=0
	local pid
	for pid in "${pids[@]}"; do
		if ! wait "$pid"; then
			rc=1
		fi
	done
	pids=()
	return "$rc"
}

for src in "${sources[@]}"; do
	compile "$src" &
	pids+=("$!")
	if [[ "${#pids[@]}" -ge "$jobs" ]]; then
		wait_batch
	fi
done
if [[ "${#pids[@]}" -gt 0 ]]; then
	wait_batch
fi

# LeakSanitizer exists on Linux. Apple's toolchain rejects detect_leaks=1.
detect_leaks=0
if [[ "$(uname -s)" == "Linux" ]]; then
	detect_leaks=1
fi
export ASAN_OPTIONS="detect_leaks=$detect_leaks:halt_on_error=1:abort_on_error=0"
export UBSAN_OPTIONS="print_stacktrace=1:halt_on_error=1"

failed=0
for src in "${sources[@]}"; do
	name="$(basename "$src" .c)"
	args=()
	if [[ "$name" == "test_conformance" ]]; then
		args=("$conformance_dir")
	fi
	echo "run_sanitized: $name"
	if ! "$out/$name" "${args[@]}"; then
		echo "run_sanitized: $name failed under ASan/UBSan" >&2
		failed=1
	fi
done

if [[ "$failed" -ne 0 ]]; then
	exit 1
fi
echo "run_sanitized: all suites are clean under ASan and UBSan"
