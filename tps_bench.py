#!/usr/bin/env python3
"""Proper TPS benchmark for any OpenAI-compatible endpoint.
Uses 'requests' library for better HTTP handling."""
import argparse
import json
import statistics
import time
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://jimcf.mosesman831.workers.dev/v1")
    parser.add_argument("--model", default="llama3.1-8B")
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()

    base_url = args.url.rstrip("/")
    chat_url = f"{base_url}/chat/completions"
    model = args.model

    print(f"Benchmarking: {chat_url}")
    print(f"Model: {model}")
    print(f"Runs per test: {args.runs}")
    print()

    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})

    # === 1. Warmup + RTT ===
    print("--- Network RTT ---")
    rtts = []
    for _ in range(args.runs * 2):
        start = time.perf_counter()
        try:
            r = session.get(f"{base_url}/models", timeout=10)
            rtts.append((time.perf_counter() - start) * 1000)
        except Exception:
            pass
    if rtts:
        print(f"  GET /models:  mean={statistics.mean(rtts):.0f}ms  median={statistics.median(rtts):.0f}ms  min={min(rtts):.0f}ms  max={max(rtts):.0f}ms")
    avg_rtt = statistics.mean(rtts) if rtts else 80
    print(f"  (using avg RTT={avg_rtt:.0f}ms for corrections)")

    # === 2. RTT + chat completion round trip ===
    print("\n  Chat request RTT (tiny prompt, no generation):")
    tiny_rtts = []
    for _ in range(args.runs):
        start = time.perf_counter()
        try:
            r = session.post(chat_url, json={
                "model": model,
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 1,
                "temperature": 0,
            }, timeout=30)
            data = r.json()
            tot = (time.perf_counter() - start) * 1000
            tiny_rtts.append(tot)
        except Exception as e:
            print(f"  Error: {e}")
    if tiny_rtts:
        print(f"  POST /chat (1 token):  mean={statistics.mean(tiny_rtts):.0f}ms  median={statistics.median(tiny_rtts):.0f}ms")

    # === 3. TPS at various generation sizes ===
    print("\n--- TPS by generation size ---")
    print(f"{'Size':>8s}  {'Token':>8s}  {'Total':>7s}  {'RTT':>5s}  {'Gen':>5s}  {'TPS':>8s}")
    print("-" * 55)

    prompts = {
        64:   "hi",
        128:  "Write a short paragraph about cats.",
        256:  "Write a story about a robot learning to paint.",
        384:  "Write a detailed analysis of renewable energy sources.",
        512:  "Write a comprehensive guide to getting started with Python programming for beginners.",
        768:  "Write a detailed essay about the causes and effects of World War I.",
        1024: "Write a long, detailed analysis of the history of computer science from Babbage to AI.",
    }

    results = {}
    for target_tokens, prompt in prompts.items():
        tok_counts = []
        latencies = []
        for _ in range(args.runs):
            try:
                start = time.perf_counter()
                r = session.post(chat_url, json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": target_tokens,
                    "temperature": 0,
                }, timeout=120)
                elapsed = (time.perf_counter() - start) * 1000
                data = r.json()
                usage = data.get("usage", {})
                ct = usage.get("completion_tokens", 0)
                if ct == 0:
                    ct = len(data["choices"][0]["message"]["content"]) // 4
                if ct > 0:
                    tok_counts.append(ct)
                    latencies.append(elapsed)
            except Exception as e:
                print(f"  Error at {target_tokens}: {e}")

        if tok_counts:
            avg_tok = statistics.mean(tok_counts)
            avg_lat = statistics.mean(latencies)
            gen_ms = max(avg_lat - avg_rtt, 1)
            tps = avg_tok / gen_ms * 1000
            results[target_tokens] = (avg_tok, avg_lat, tps)
            print(f"  target={target_tokens:>4d}:  {avg_tok:>5.0f}tok  {avg_lat:>6.0f}ms  {avg_rtt:>4.0f}  {gen_ms:>4.0f}  {tps:>7.0f}")

    # === 4. Converged TPS estimate ===
    print("\n--- TPS convergence (as generation grows, RTT becomes noise) ---")
    if results:
        # The TPS converges toward true throughput as token count increases
        largest = max(results.keys())
        avg_tok, avg_lat, tps = results[largest]
        print(f"  Largest gen ({largest} target): {tps:.0f} TPS")
        print(f"  This is the closest to true GPU TPS (RTT is {avg_rtt}ms of {avg_lat:.0f}ms)")

        # Estimate raw GPU TPS by subtracting RTT
        for sz, (t, l, _) in sorted(results.items()):
            raw_gen = max(l - avg_rtt, 1)
            raw_tps = t / raw_gen * 1000
            rtt_pct = avg_rtt / l * 100 if l > 0 else 100
            print(f"    {sz:>4d}tok:  RTT={rtt_pct:.0f}% of latency,  raw TPS={raw_tps:.0f}")

    # === 5. Parallel throughput ===
    print("\n--- Parallel throughput (3 concurrent) ---")
    big_prompt = "Write a long, detailed analysis of the history of computer science."
    bodies = [
        {"model": model, "messages": [{"role": "user", "content": big_prompt}], "max_tokens": 1024, "temperature": 0}
        for _ in range(args.runs)
    ]

    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = [ex.submit(lambda b: session.post(chat_url, json=b, timeout=120), b) for b in bodies]
        responses = [f.result() for f in as_completed(futures)]
    total_elapsed = (time.perf_counter() - start) * 1000

    total_tokens = 0
    for r in responses:
        d = r.json()
        ct = d.get("usage", {}).get("completion_tokens", 0) or len(d["choices"][0]["message"]["content"]) // 4
        total_tokens += ct

    if total_elapsed > 0:
        print(f"  {len(responses)} requests in {total_elapsed:.0f}ms total")
        print(f"  Total tokens: {total_tokens}")
        print(f"  Aggregate throughput: {total_tokens / (total_elapsed / 1000):.0f} tok/s")

    # === 6. Summary ===
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Endpoint: {chat_url}")
    print(f"  Model: {model}")
    print(f"  Network RTT: {avg_rtt:.0f}ms")
    if results:
        largest = max(results.keys())
        avg_tok, avg_lat, tps = results[largest]
        print(f"  Converged TPS (at {avg_tok:.0f} tokens): ~{tps:.0f}")
        print(f"  Raw GPU TPS estimate (RTT subtracted): Up to {results[max(results.keys())][2]:.0f}")
        print(f"  Note: TPS increases with generation size as RTT becomes negligible")
    print(f"  True GPU TPS would require measuring at 4000+ tokens")


if __name__ == "__main__":
    main()
