#!/usr/bin/env python3
from __future__ import annotations

import argparse
import http.client
import json
import os
import socket
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_raw_transactions import generate_rows, load_accounts  # noqa: E402

_thread_local = threading.local()
# Bajo presión de sockets, no abrir otra conexión por cada fallo (errno 49).
_pending_infra: list[tuple[str, str, str, dict]] = []
_pending_infra_lock = threading.Lock()
_pending_infra_dropped = 0


def to_api_payload(row: dict[str, str]) -> dict:
    return {
        "uid": row["uid"],
        "account": row["account"],
        "typeCode": row["type_code"],
        "typeName": row["type_name"],
        "natureCode": row["nature_code"],
        "productCode": row["product_code"],
        "status": row["status"],
        "amount": row["amount"],
        "currency": row["currency"],
        "date": row["date"],
        "counterpartName": row["counterpart_name"],
        "category": row["category"],
        "rejectReason": row.get("reject_reason") or "",
    }


def _thread_conn(base_url: str, timeout: float) -> http.client.HTTPConnection:
    parsed = urlparse(base_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    key = (host, port, timeout)
    conn = getattr(_thread_local, "conn", None)
    conn_key = getattr(_thread_local, "conn_key", None)
    if conn is None or conn_key != key:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        _thread_local.conn = conn
        _thread_local.conn_key = key
    return conn


def _reset_thread_conn() -> None:
    conn = getattr(_thread_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    _thread_local.conn = None
    _thread_local.conn_key = None


def post_json(
    url: str,
    body: dict,
    timeout: float = 30.0,
    correlation_id: str | None = None,
) -> tuple[int, dict, str | None]:
    corr = correlation_id or str(uuid.uuid4())
    data = json.dumps(body).encode("utf-8")
    parsed = urlparse(url)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    base = f"{parsed.scheme}://{parsed.netloc}"

    try:
        conn = _thread_conn(base, timeout)
        conn.request(
            "POST",
            path,
            body=data,
            headers={
                "content-type": "application/json",
                "x-correlation-id": corr,
                "connection": "keep-alive",
            },
        )
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw[:300]}
        if 200 <= resp.status < 300:
            return resp.status, payload, None
        infra = None
        if resp.status >= 500:
            code = payload.get("code") if isinstance(payload, dict) else None
            infra = code if isinstance(code, str) else "SERVER_ERROR"
        return resp.status, payload, infra
    except (TimeoutError, socket.timeout):
        _reset_thread_conn()
        return 0, {"correlationId": corr}, "TIMEOUT"
    except (ConnectionError, OSError, http.client.HTTPException) as exc:
        _reset_thread_conn()
        reason = str(exc)
        if "timed out" in reason.lower():
            return 0, {"correlationId": corr, "reason": reason}, "TIMEOUT"
        return 0, {"correlationId": corr, "reason": reason}, "CONNECTION_ERROR"


def report_infra(
    base_url: str,
    error_code: str,
    message: str,
    detail: dict,
    correlation_id: str | None = None,
    *,
    defer: bool = False,
) -> str:
    corr = correlation_id or detail.get("correlationId") or str(uuid.uuid4())
    if not isinstance(corr, str):
        corr = str(uuid.uuid4())

    # En stress, diferir CONNECTION_ERROR para no multiplicar sockets (errno 49).
    if defer and error_code in {"CONNECTION_ERROR", "TIMEOUT"}:
        global _pending_infra_dropped
        with _pending_infra_lock:
            if len(_pending_infra) < 500:
                _pending_infra.append((base_url, error_code, message, {**detail, "correlationId": corr}))
            else:
                _pending_infra_dropped += 1
        return corr

    status, payload, _ = post_json(
        f"{base_url.rstrip('/')}/api/v1/infra-exceptions",
        {
            "correlationId": corr,
            "component": "emitter",
            "errorCode": error_code,
            "message": message[:2000],
            "operation": "emit_raw_transactions",
            "detail": {
                **detail,
                "correlationId": corr,
                "emitter": "etl/emit_raw_transactions.py",
            },
        },
        timeout=5.0,
        correlation_id=corr,
    )
    if status == 0 or status >= 400:
        print(
            json.dumps(
                {
                    "warn": "no_se_pudo_registrar_infra_en_api",
                    "correlationId": corr,
                    "errorCode": error_code,
                    "detail": detail,
                    "httpStatus": status,
                    "body": payload,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
    return corr


def flush_pending_infra() -> dict:
    with _pending_infra_lock:
        pending = list(_pending_infra)
        dropped = _pending_infra_dropped
        _pending_infra.clear()

    saved = 0
    failed = 0
    if not pending:
        return {"queued": 0, "saved": 0, "failed": 0, "dropped": dropped}

    def _one(item: tuple[str, str, str, dict]) -> bool:
        base_url, error_code, message, detail = item
        corr = str(detail.get("correlationId") or uuid.uuid4())
        status, _, _ = post_json(
            f"{base_url.rstrip('/')}/api/v1/infra-exceptions",
            {
                "correlationId": corr,
                "component": "emitter",
                "errorCode": error_code,
                "message": message[:2000],
                "operation": "emit_raw_transactions",
                "detail": {**detail, "deferred": True, "emitter": "etl/emit_raw_transactions.py"},
            },
            timeout=5.0,
            correlation_id=corr,
        )
        return 200 <= status < 300

    with ThreadPoolExecutor(max_workers=4) as pool:
        for ok_flag in pool.map(_one, pending):
            if ok_flag:
                saved += 1
            else:
                failed += 1
    return {"queued": len(pending), "saved": saved, "failed": failed, "dropped": dropped}


def get_json(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def chunked(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def render_progress(
    done: int,
    total: int,
    *,
    ok: int = 0,
    infra: int = 0,
    started: float | None = None,
    label: str = "Progreso",
) -> None:
    total = max(total, 1)
    done = min(done, total)
    pct = done / total
    width = 28
    filled = int(width * pct)
    bar = "█" * filled + "░" * (width - filled)
    elapsed = (time.perf_counter() - started) if started is not None else 0.0
    rate = (done / elapsed) if elapsed > 0 else 0.0
    msg = (
        f"\r{label} |{bar}| {done}/{total} ({pct * 100:5.1f}%) "
        f"ok={ok} infra={infra} {rate:6.1f} req/s"
    )
    print(msg, end="", flush=True)
    if done >= total:
        print()


def snapshot_infra_total(base_url: str) -> int:
    try:
        return int(get_json(f"{base_url.rstrip('/')}/api/v1/infra-exceptions/stats").get("total", 0))
    except Exception:
        return 0


def run_populate(args: argparse.Namespace) -> None:
    accounts = load_accounts(args.database_url)
    rows = generate_rows(accounts, args.count, args.seed)
    prefix = args.uid_prefix or f"run{int(time.time())}"
    for row in rows:
        num = row["uid"].split("-", 1)[-1]
        row["uid"] = f"txn-{prefix}-{num}"

    batches = list(chunked(rows, args.batch_size))
    accepted = 0
    duplicates = 0
    infra_failed = 0
    business_rejected = 0
    started = time.perf_counter()
    base = args.base_url.rstrip("/")
    infra_before = snapshot_infra_total(base)

    print(
        json.dumps(
            {
                "mode": "populate",
                "count": len(rows),
                "batchSize": args.batch_size,
                "baseUrl": args.base_url,
                "rule": "negocio→raw_transactions; excepción→infra_exceptions",
            },
            ensure_ascii=False,
        )
    )

    for i, batch in enumerate(batches, start=1):
        corr = str(uuid.uuid4())
        status, payload, infra = post_json(
            f"{base}/api/v1/raw-transactions/batch",
            {"items": [to_api_payload(r) for r in batch]},
            correlation_id=corr,
        )
        if infra or status == 0 or status >= 500:
            code = infra or "SERVER_ERROR"
            report_infra(
                base,
                code,
                f"Fallo de infraestructura al enviar lote ({status})",
                {
                    "correlationId": corr,
                    "batchSize": len(batch),
                    "uids": [r["uid"] for r in batch[:5]],
                    "accounts": [r["account"] for r in batch[:5]],
                    "httpStatus": status,
                },
                correlation_id=corr,
            )
            infra_failed += len(batch)
        elif status >= 400:
            report_infra(
                base,
                "CLIENT_OR_VALIDATION_ERROR",
                f"HTTP {status} al enviar lote",
                {"correlationId": corr, "httpStatus": status, "body": payload},
                correlation_id=corr,
            )
            infra_failed += len(batch)
        else:
            accepted += int(payload.get("accepted", 0))
            duplicates += int(payload.get("duplicates", 0))
            business_rejected += int(payload.get("businessRejected", 0))
            infra_failed += int(payload.get("infraFailed", 0))
        done = min(i * args.batch_size, len(rows))
        render_progress(done, len(rows), ok=accepted, infra=infra_failed, started=started, label="Populate")

    elapsed = time.perf_counter() - started
    stats = get_json(f"{base}/api/v1/raw-transactions/stats")
    infra_after = snapshot_infra_total(base)
    print(
        json.dumps(
            {
                "sent": len(rows),
                "acceptedInRawTable": accepted,
                "businessRejectedInRawTable": business_rejected,
                "duplicates": duplicates,
                "infraExceptionsThisRun": infra_failed,
                "infraExceptionsInDbTotal": infra_after,
                "infraExceptionsInDbBefore": infra_before,
                "note": "infraExceptionsInDbTotal incluye historial previo; ThisRun es solo esta corrida",
                "elapsedSec": round(elapsed, 3),
                "throughput": round(len(rows) / elapsed, 1) if elapsed else 0,
                "dbStats": stats,
            },
            indent=2,
            ensure_ascii=False,
        )
    )


def ask_positive_int(prompt: str, default: int) -> int:
    while True:
        raw = input(f"{prompt} [{default}]: ").strip()
        if raw == "":
            return default
        try:
            value = int(raw)
            if value >= 1:
                return value
        except ValueError:
            pass
        print("  Ingresa un entero >= 1.")


def prompt_stress_params(args: argparse.Namespace) -> None:
    print()
    print("=== Prueba de estrés SmartBancs ===")
    print("Simula usuarios reales: 1 HTTP POST = 1 transacción (sin lotes).")
    print("  - Negocio (ok / sin fondos / rechazos) → raw_transactions")
    print("  - Excepciones (timeout, DB, 5xx)      → infra_exceptions")
    print("  - Si no se alcanza el TPS pedido, el JSON reporta la capacidad real.")
    print()
    args.duration = ask_positive_int(
        "¿Cuántos segundos durará la prueba de estrés?",
        getattr(args, "duration", 20) or 20,
    )
    args.tps = ask_positive_int(
        "¿Cuántas transacciones concurrentes por segundo? (1 req = 1 TX)",
        getattr(args, "tps", 100) or 100,
    )
    planned = args.tps * args.duration
    workers = max(1, min(getattr(args, "concurrency", 256) or 256, args.tps, 512))
    max_inflight = workers * 2
    print()
    print(f"Resumen: objetivo {args.tps} req/s × {args.duration}s ≈ {planned} TX")
    print(f"         concurrencia cliente={workers} (inflight máx={max_inflight})")
    print("         Sin lotizar: el sistema debe absorber la carga o fallar de forma visible.")
    confirm = input("¿Iniciar? [S/n]: ").strip().lower()
    if confirm in {"n", "no"}:
        raise SystemExit("Prueba cancelada.")
    print("Iniciando…")
    print()


def run_stress(args: argparse.Namespace) -> None:
    if not getattr(args, "no_prompt", False):
        prompt_stress_params(args)

    tps = max(1, args.tps)
    duration = max(1, args.duration)
    total = tps * duration
    accounts = load_accounts(args.database_url)
    if not accounts:
        raise SystemExit(
            "No hay cuentas en la BD. Arranca el API (seed) o restaura cuentas antes del estrés."
        )
    rows = generate_rows(accounts, total, args.seed)
    prefix = args.uid_prefix or f"stress{int(time.time())}"
    for i, row in enumerate(rows, start=1):
        row["uid"] = f"txn-{prefix}-{i:06d}"

    base = args.base_url.rstrip("/")
    url_one = f"{base}/api/v1/raw-transactions"
    workers = max(1, min(getattr(args, "concurrency", 256) or 256, tps, 512))
    max_inflight = workers * 2
    interval = 1.0 / tps

    ok = 0
    infra_err = 0
    latencies: list[float] = []
    started = time.perf_counter()
    deadline = started + duration
    infra_before = snapshot_infra_total(base)
    lock = threading.Lock()
    done_count = 0

    print(
        json.dumps(
            {
                "mode": "stress",
                "tpsTarget": tps,
                "durationSec": duration,
                "planned": total,
                "concurrency": workers,
                "baseUrl": args.base_url,
                "contract": "1 HTTP POST = 1 TX (sin lotes). Capacidad real = acceptedTps.",
                "rule": "negocio→raw_transactions; excepción→infra_exceptions",
            },
            ensure_ascii=False,
        )
    )
    print(f"Progreso en vivo. Objetivo: {tps} req/s durante {duration}s ({total} TX)")
    render_progress(0, total, ok=0, infra=0, started=started, label="Estrés")

    def send_one(row: dict[str, str]) -> tuple[str, float, int]:
        corr = str(uuid.uuid4())
        t0 = time.perf_counter()
        status, payload, infra = post_json(
            url_one,
            to_api_payload(row),
            timeout=10.0,
            correlation_id=corr,
        )
        ms = (time.perf_counter() - t0) * 1000
        if 200 <= status < 300:
            return "ok", ms, status
        code = infra or (payload.get("code") if isinstance(payload, dict) else None) or "SERVER_ERROR"
        if not isinstance(code, str):
            code = "SERVER_ERROR"
        detail = {
            "correlationId": corr,
            "uid": row["uid"],
            "account": row["account"],
            "typeCode": row["type_code"],
            "typeName": row["type_name"],
            "amount": row["amount"],
            "status": row["status"],
            "httpStatus": status,
        }
        if status == 0 or infra in {"TIMEOUT", "CONNECTION_ERROR"}:
            report_infra(
                base,
                code,
                f"Excepción al emitir {row['uid']}",
                detail,
                correlation_id=corr,
                defer=True,
            )
        elif status >= 500:
            detail["body"] = payload
            report_infra(
                base,
                code,
                f"HTTP {status} al emitir {row['uid']}",
                detail,
                correlation_id=corr,
                defer=False,
            )
        return "infra", ms, status

    def on_done(fut) -> None:
        nonlocal ok, infra_err, done_count
        kind, ms, _status = fut.result()
        with lock:
            latencies.append(ms)
            if kind == "ok":
                ok += 1
            else:
                infra_err += 1
            done_count += 1
            if done_count % 50 == 0 or done_count >= total:
                render_progress(done_count, total, ok=ok, infra=infra_err, started=started, label="Estrés")

    idx = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures: list = []
        next_at = started
        while time.perf_counter() < deadline and idx < len(rows):
            now = time.perf_counter()
            if now < next_at:
                time.sleep(min(next_at - now, 0.001))
                continue
            futures = [f for f in futures if not f.done()]
            if len(futures) >= max_inflight:
                time.sleep(0.0005)
                continue
            fut = pool.submit(send_one, rows[idx])
            fut.add_done_callback(on_done)
            futures.append(fut)
            idx += 1
            next_at += interval
            if next_at < time.perf_counter() - 1.0:
                next_at = time.perf_counter()

        for fut in as_completed(futures):
            pass

    time.sleep(0.05)
    render_progress(ok + infra_err, total, ok=ok, infra=infra_err, started=started, label="Estrés")
    print()
    deferred = flush_pending_infra()
    elapsed = time.perf_counter() - started
    latencies.sort()
    p50 = latencies[int(len(latencies) * 0.5)] if latencies else 0
    p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
    stats = get_json(f"{base}/api/v1/raw-transactions/stats")
    infra_after = snapshot_infra_total(base)
    attempted = ok + infra_err
    print(
        json.dumps(
            {
                "planned": total,
                "attempted": attempted,
                "acceptedInRawTable": ok,
                "infraExceptionsThisRun": infra_err,
                "infraExceptionsInDbBefore": infra_before,
                "infraExceptionsInDbTotal": infra_after,
                "infraExceptionsAddedInDb": max(0, infra_after - infra_before),
                "infraDeferredFlush": deferred,
                "hitTpsTarget": round(ok / elapsed, 1) >= tps * 0.95 if elapsed else False,
                "note": (
                    "1 POST = 1 TX. Si acceptedTps < tpsTarget, esa es la capacidad real "
                    "del stack actual (API/DB/cliente)."
                ),
                "elapsedSec": round(elapsed, 3),
                "tpsTarget": tps,
                "achievedTps": round(attempted / elapsed, 1) if elapsed else 0,
                "acceptedTps": round(ok / elapsed, 1) if elapsed else 0,
                "latencyMs": {
                    "p50": round(p50, 1),
                    "p95": round(p95, 1),
                    "max": round(max(latencies), 1) if latencies else 0,
                },
                "dbStats": stats,
            },
            indent=2,
            ensure_ascii=False,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Emite transacciones crudas al API SmartBancs")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("API_BASE_URL", "http://localhost:3000"),
    )
    parser.add_argument(
        "--database-url",
        default=os.environ.get(
            "DATABASE_URL",
            "postgresql://smartbancs:smartbancs@localhost:5432/smartbancs",
        ),
    )
    parser.add_argument("--seed", type=int, default=42)
    sub = parser.add_subparsers(dest="mode", required=True)

    p_pop = sub.add_parser("populate", help="Poblar N transacciones crudas")
    p_pop.add_argument("--count", type=int, default=5000)
    p_pop.add_argument("--batch-size", type=int, default=100)
    p_pop.add_argument("--uid-prefix", default="")

    p_stress = sub.add_parser("stress", help="Estrés: pregunta duración y req/s en consola")
    p_stress.add_argument("--tps", type=int, default=100, help="Default si Enter (req/s)")
    p_stress.add_argument("--duration", type=int, default=20, help="Default si Enter (segundos)")
    p_stress.add_argument("--concurrency", type=int, default=256, help="Workers cliente (techo 512; inflight=workers*2)")
    p_stress.add_argument("--uid-prefix", default="")
    p_stress.add_argument(
        "--no-prompt",
        action="store_true",
        help="No preguntar; usa --tps y --duration directamente",
    )

    args = parser.parse_args()
    if args.mode == "populate":
        run_populate(args)
    else:
        run_stress(args)


if __name__ == "__main__":
    main()
