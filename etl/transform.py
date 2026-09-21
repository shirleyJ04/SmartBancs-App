#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from uafe_catalog import (
    BUSINESS_TIPOS,
    NATURALEZA,
    PRODUCTO,
    TIPO_UAFE,
    is_valid_combo,
    label_for,
    normalize_tipo,
)

ROOT = Path(__file__).resolve().parent.parent
ACCOUNT_PATTERN = re.compile(r"^ACC-\d{3,5}$")
BUSINESS_STATUSES = {"COMPLETED", "REJECTED"}
DROP_REJECT_REASONS = {"ACCOUNT_NOT_FOUND"}
INFRA_MARKERS = {"INFRA", "TIMEOUT", "INFRA_FAILURE", "CONNECTION_ERROR"}
CURRENT_MONTH = "2026-09"
PREVIOUS_MONTH = "2026-08"

DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%d-%m-%y",
    "%d/%m/%y",
)


def normalize_amount(value: object) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if text == "" or text.lower() in {"null", "none", "nan", "n/a"}:
        return None
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".")
    elif "," in text:
        text = text.replace(",", ".")
    if re.fullmatch(r"\d+\.\d{3}", text):
        return None
    if not re.fullmatch(r"-?\d+(\.\d{1,2})?", text):
        return None
    amount = float(text)
    if amount <= 0:
        return None
    return f"{amount:.2f}"


def normalize_date(value: object) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if text == "" or text.lower() in {"null", "none", "nan"}:
        return None
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def normalize_nature(value: object) -> str | None:
    text = str(value or "").strip().upper()
    if text in NATURALEZA:
        return text
    return None


def is_infra(row: pd.Series) -> bool:
    status = str(row.get("status", "")).strip().upper()
    event_class = str(row.get("event_class", "")).strip().upper()
    return event_class == "INFRA" or status in INFRA_MARKERS


def ratio(current: float, previous: float) -> float | None:
    if previous <= 0:
        return None
    return round(current / previous, 2)


def percent_change(current: float, previous: float) -> float | None:
    if previous <= 0:
        return None
    return round(((current - previous) / previous) * 100, 1)


def build_prompt(account: str, stats: dict) -> str:
    lines = [
        "Eres un asesor financiero de SmartBancs (Ecuador).",
        "Usa solo el ledger UAFE ya limpio. Ignora timeouts y fallos de infraestructura.",
        "Los movimientos usan tipo UAFE, naturaleza D/C y producto (AHO, TJC, INV…).",
        f"Cuenta: {account}.",
        f"Gasto {CURRENT_MONTH}: {stats['currentTotal']:.2f} USD. "
        f"Gasto {PREVIOUS_MONTH}: {stats['previousTotal']:.2f} USD.",
    ]
    pct = percent_change(stats["currentTotal"], stats["previousTotal"])
    if stats["totalRatio"] is not None and pct is not None:
        lines.append(
            f"El gasto total de este mes es {stats['totalRatio']} veces el del mes pasado "
            f"({pct:+.1f}%)."
        )
    elif stats["previousTotal"] <= 0:
        lines.append(
            "Aún no hay gasto comparable del mes anterior: pide más historial (NEED_MORE_DATA) "
            "si no puedes contrastar cifras."
        )
    for category, detail in stats["categories"].items():
        if detail["ratio"] is not None and detail["ratio"] >= 2:
            cat_pct = percent_change(detail["current"], detail["previous"])
            pct_txt = f", {cat_pct:+.1f}%" if cat_pct is not None else ""
            lines.append(
                f"En {category} gastó {detail['ratio']} veces más que el mes pasado "
                f"({detail['current']:.2f} vs {detail['previous']:.2f}{pct_txt})."
            )
    if stats["rejectedCards"] > 0:
        lines.append(f"Hubo {stats['rejectedCards']} consumo(s) TJC rechazados (tipo 37 D).")
    if stats.get("byTipo"):
        top = ", ".join(f"{k}={v:.2f}" for k, v in list(stats["byTipo"].items())[:5])
        lines.append(f"Distribución por tipo UAFE este mes: {top}.")
    if stats["counterparts"]:
        lines.append("Contrapartes recientes: " + ", ".join(stats["counterparts"][:5]) + ".")
    lines.append(
        "Devuelve una recomendación concreta y breve con cifras o %, "
        "o indica que aún se necesita más historial."
    )
    return " ".join(lines)


def transform(input_path: Path, output_path: Path, rejected_path: Path, infra_path: Path, prompts_path: Path) -> dict:
    raw = pd.read_csv(input_path, dtype=str, keep_default_na=False)
    accepted: list[dict] = []
    rejected: list[dict] = []
    infra_excluded: list[dict] = []
    total_rows = len(raw)

    for index, row in raw.iterrows():
        line = int(index) + 2
        if line % 100_000 == 0:
            print(json.dumps({"progress": "cleaning", "line": line, "of": total_rows}, ensure_ascii=False), flush=True)
        raw_json = json.dumps(row.to_dict(), ensure_ascii=False)
        if is_infra(row):
            infra_excluded.append(
                {
                    "line": line,
                    "uid": str(row.get("uid", "")),
                    "reason": "evento_infra_no_va_al_ledger_ia",
                    "status": str(row.get("status", "")),
                    "raw": raw_json,
                }
            )
            continue

        reasons: list[str] = []
        account = str(row.get("account", "")).strip().upper()
        if not account or account in {"NULL", "NONE", "N/A"} or not ACCOUNT_PATTERN.match(account):
            reasons.append("cuenta_invalida_o_nula")

        type_code = normalize_tipo(row.get("type_code") or row.get("type"))
        if type_code is None or type_code not in BUSINESS_TIPOS:
            reasons.append("tipo_uafe_invalido")

        type_name = str(row.get("type_name", "")).strip() or (TIPO_UAFE.get(type_code, "") if type_code else "")

        nature = normalize_nature(row.get("nature_code"))
        if nature is None:
            reasons.append("naturaleza_invalida")

        product = str(row.get("product_code", "")).strip().upper()
        if product not in PRODUCTO:
            reasons.append("producto_uafe_invalido")
        elif type_code and nature and not is_valid_combo(type_code, nature, product):
            reasons.append("combo_tipo_producto_no_permitido")

        status = str(row.get("status", "")).strip().upper()
        if status not in BUSINESS_STATUSES:
            reasons.append("estado_no_es_registro_de_negocio")

        reject_reason = str(row.get("reject_reason", "")).strip().upper()
        if status == "REJECTED" and reject_reason in DROP_REJECT_REASONS:
            reasons.append("rechazo_cuenta_inexistente_no_va_al_ledger_ia")

        amount = normalize_amount(row.get("amount"))
        if amount is None:
            reasons.append("monto_invalido")

        currency = str(row.get("currency", "")).strip().upper()
        if currency != "USD":
            reasons.append("moneda_no_soportada")

        booked_on = normalize_date(row.get("date"))
        if booked_on is None:
            reasons.append("fecha_invalida")

        counterpart = str(row.get("counterpart_name", "")).strip()
        if not counterpart or counterpart.lower() in {"null", "none", "nan", "n/a"}:
            reasons.append("contraparte_vacia")

        category = str(row.get("category", "other")).strip().lower() or "other"
        uid = str(row.get("uid", "")).strip()
        if not uid:
            reasons.append("uid_vacio")

        if reasons:
            rejected.append({"line": line, "reason": "|".join(reasons), "raw": raw_json})
            continue

        accepted.append(
            {
                "uid": uid,
                "accountNumber": account,
                "typeCode": type_code,
                "typeName": type_name or TIPO_UAFE.get(type_code, type_code),
                "natureCode": nature,
                "productCode": product,
                "typeLabel": label_for(type_code, nature, product),
                "status": status,
                "amount": amount,
                "currency": currency,
                "bookedOn": booked_on,
                "month": booked_on[:7],
                "counterpartName": counterpart,
                "category": category,
            }
        )

    print(
        json.dumps(
            {"progress": "aggregating", "accepted": len(accepted), "dirty": len(rejected), "infra": len(infra_excluded)},
            ensure_ascii=False,
        ),
        flush=True,
    )
    per_account: dict[str, dict] = {}
    grouped: dict[str, list[dict]] = defaultdict(list)
    for record in accepted:
        grouped[record["accountNumber"]].append(record)

    for account, rows in grouped.items():
        current = [row for row in rows if row["month"] == CURRENT_MONTH and row["status"] == "COMPLETED"]
        previous = [row for row in rows if row["month"] == PREVIOUS_MONTH and row["status"] == "COMPLETED"]
        current_debit = [row for row in current if row["natureCode"] == "D"]
        previous_debit = [row for row in previous if row["natureCode"] == "D"]
        current_total = sum(float(row["amount"]) for row in current_debit)
        previous_total = sum(float(row["amount"]) for row in previous_debit)
        categories: dict[str, dict] = {}
        for category in {row["category"] for row in rows}:
            cur = sum(float(row["amount"]) for row in current_debit if row["category"] == category)
            prev = sum(float(row["amount"]) for row in previous_debit if row["category"] == category)
            categories[category] = {"current": round(cur, 2), "previous": round(prev, 2), "ratio": ratio(cur, prev)}
        by_tipo: dict[str, float] = defaultdict(float)
        for row in current_debit:
            key = f"{row['typeCode']}-{row['natureCode']}-{row['productCode']}"
            by_tipo[key] += float(row["amount"])
        stats = {
            "currentTotal": round(current_total, 2),
            "previousTotal": round(previous_total, 2),
            "totalRatio": ratio(current_total, previous_total),
            "categories": categories,
            "byTipo": {k: round(v, 2) for k, v in sorted(by_tipo.items(), key=lambda x: -x[1])},
            "rejectedCards": sum(
                1 for row in rows if row["productCode"] == "TJC" and row["status"] == "REJECTED"
            ),
            "counterparts": list(dict.fromkeys(row["counterpartName"] for row in rows)),
        }
        per_account[account] = {
            "accountNumber": account,
            "asOfMonth": CURRENT_MONTH,
            "compareMonth": PREVIOUS_MONTH,
            **stats,
            "prompt": build_prompt(account, stats),
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "purpose": "ledger_uafe_ecuador_para_prompt_de_ia",
        "catalog": "UAFE RESU tipo + naturaleza D/C + producto",
        "records": accepted,
    }
    json_indent = 2 if len(accepted) <= 20_000 else None
    print(json.dumps({"progress": "writing_files", "records": len(accepted)}, ensure_ascii=False), flush=True)
    output_path.write_text(json.dumps(payload, indent=json_indent, ensure_ascii=False) + "\n", encoding="utf-8")
    prompts_path.write_text(
        json.dumps({"generatedAt": payload["generatedAt"], "accounts": per_account}, indent=json_indent, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    pd.DataFrame(rejected, columns=["line", "reason", "raw"]).to_csv(rejected_path, index=False)
    pd.DataFrame(infra_excluded).to_csv(infra_path, index=False)

    summary = {
        "input": str(input_path),
        "businessAccepted": len(accepted),
        "dirtyRejected": len(rejected),
        "infraExcluded": len(infra_excluded),
        "promptAccounts": len(per_account),
        "ledger": str(output_path),
        "prompts": str(prompts_path),
        "rejected": str(rejected_path),
        "infra": str(infra_path),
    }
    loaded = persist_to_ai_db(accepted, per_account)
    if loaded is not None:
        summary["aiDbLoaded"] = loaded
        print(json.dumps({"progress": "ai_db_loaded", **loaded}, ensure_ascii=False), flush=True)
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return summary


def persist_to_ai_db(accepted: list[dict], per_account: dict[str, dict]) -> dict | None:
    url = os.environ.get("AI_DATABASE_URL")
    if not url:
        return None
    import psycopg2
    from psycopg2.extras import Json, execute_values

    schema_path = Path(os.environ.get("AI_SCHEMA_SQL", ROOT / "services" / "ai" / "sql" / "init.sql"))
    schema = schema_path.read_text(encoding="utf-8")
    conn = psycopg2.connect(url)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                DO $$
                BEGIN
                  IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'ai_transactions' AND column_name = 'type'
                  ) OR NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'ai_transactions' AND column_name = 'type_code'
                  ) THEN
                    DROP TABLE IF EXISTS ai_transactions;
                  END IF;
                END $$;
                """
            )
            cur.execute(schema)
            cur.execute("TRUNCATE ai_transactions, ai_prompt_contexts")
            tx_rows = [
                (
                    row["uid"],
                    row["accountNumber"],
                    row["typeCode"],
                    row["natureCode"],
                    row["productCode"],
                    row["typeLabel"],
                    row["status"],
                    row["amount"],
                    row["currency"],
                    row["bookedOn"],
                    row["month"],
                    row["counterpartName"],
                    row["category"],
                )
                for row in accepted
            ]
            if tx_rows:
                execute_values(
                    cur,
                    """
                    INSERT INTO ai_transactions (
                        uid, account_number, type_code, nature_code, product_code, type_label,
                        status, amount, currency, booked_on, month, counterpart_name, category
                    ) VALUES %s
                    """,
                    tx_rows,
                    page_size=5000,
                )
            ctx_rows = [
                (
                    account,
                    ctx["asOfMonth"],
                    ctx["compareMonth"],
                    ctx["currentTotal"],
                    ctx["previousTotal"],
                    ctx["totalRatio"],
                    ctx["rejectedCards"],
                    Json(ctx["counterparts"]),
                    Json(ctx["categories"]),
                    ctx["prompt"],
                )
                for account, ctx in per_account.items()
            ]
            if ctx_rows:
                execute_values(
                    cur,
                    """
                    INSERT INTO ai_prompt_contexts (
                        account_number, as_of_month, compare_month, current_total, previous_total,
                        total_ratio, rejected_cards, counterparts, categories, prompt
                    ) VALUES %s
                    """,
                    ctx_rows,
                    page_size=2000,
                )
        return {"transactions": len(accepted), "contexts": len(per_account)}
    finally:
        conn.close()


def load_raw_from_bank_db(database_url: str) -> list[dict[str, str]]:
    import psycopg2
    from psycopg2 import errors

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    """
                    SELECT uid, account_number, type_code, type_name, nature_code, product_code,
                           status, amount::text, currency, booked_on::text, counterpart_name,
                           category, COALESCE(reject_reason, '')
                    FROM raw_transactions
                    ORDER BY booked_on, uid
                    """
                )
            except errors.UndefinedTable:
                conn.rollback()
                return []
            out: list[dict[str, str]] = []
            for row in cur.fetchall():
                out.append(
                    {
                        "uid": row[0],
                        "account": row[1],
                        "type_code": row[2],
                        "type_name": row[3],
                        "nature_code": row[4],
                        "product_code": row[5],
                        "status": row[6],
                        "amount": row[7],
                        "currency": row[8],
                        "date": row[9],
                        "counterpart_name": row[10],
                        "category": row[11],
                        "reject_reason": row[12],
                        "event_class": "",
                    }
                )
            return out
    finally:
        conn.close()


def main() -> None:
    testdata = ROOT / "testdata"
    from_db = "--from-db" in sys.argv
    argv = [a for a in sys.argv[1:] if a != "--from-db"]
    input_path = Path(argv[0]) if len(argv) > 0 else testdata / "raw_transactions.csv"
    output_path = Path(argv[1]) if len(argv) > 1 else testdata / "clean_transactions.json"
    rejected_path = Path(argv[2]) if len(argv) > 2 else testdata / "rejected.csv"
    infra_path = Path(argv[3]) if len(argv) > 3 else testdata / "excluded_infra.csv"
    prompts_path = Path(argv[4]) if len(argv) > 4 else testdata / "prompt_contexts.json"

    if from_db:
        db_url = os.environ.get(
            "DATABASE_URL",
            "postgresql://smartbancs:smartbancs@localhost:5432/smartbancs",
        )
        rows = load_raw_from_bank_db(db_url)
        if rows:
            input_path.parent.mkdir(parents=True, exist_ok=True)
            import csv

            with input_path.open("w", encoding="utf-8", newline="") as fh:
                fields = [
                    "uid",
                    "account",
                    "type_code",
                    "type_name",
                    "nature_code",
                    "product_code",
                    "status",
                    "amount",
                    "currency",
                    "date",
                    "counterpart_name",
                    "category",
                    "reject_reason",
                ]
                writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
                writer.writeheader()
                writer.writerows(rows)
            print(json.dumps({"exportedFromDb": len(rows), "to": str(input_path)}, ensure_ascii=False))
        else:
            sample = testdata / "raw_transactions.sample.csv"
            if not input_path.exists() and sample.exists():
                input_path = sample
            print(
                json.dumps(
                    {"exportedFromDb": 0, "fallbackCsv": str(input_path)},
                    ensure_ascii=False,
                )
            )

    transform(input_path, output_path, rejected_path, infra_path, prompts_path)


if __name__ == "__main__":
    main()
