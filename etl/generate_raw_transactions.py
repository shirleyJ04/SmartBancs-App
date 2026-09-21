#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from uafe_catalog import TIPO_UAFE, is_valid_combo  # noqa: E402

TEMPLATES: list[tuple[str, str, str, str, int]] = [
    ("03", "C", "AHO", "deposit", 14),
    ("71", "D", "AHO", "cash", 12),
    ("34", "D", "AHO", "transfer", 12),
    ("35", "C", "AHO", "transfer", 8),
    ("37", "D", "TJC", "food", 10),
    ("37", "D", "TJC", "shopping", 6),
    ("37", "D", "AHO", "utilities", 6),
    ("08", "D", "TJC", "shopping", 8),
    ("06", "D", "INV", "investment", 7),
    ("36", "C", "AHO", "adjustment", 5),
    ("21", "D", "AHO", "transfer", 4),
    ("72", "D", "CTE", "cash", 3),
    ("07", "D", "INV", "investment", 2),
    ("12", "C", "INV", "investment", 2),
    ("11", "C", "PRE", "loan", 1),
]

MERCHANTS = {
    "food": ["Mercado Central", "Café Lima", "Restaurante Andes", "Supermercado Norte", "Bar La Esquina"],
    "shopping": ["Tienda Tech", "Mall del Pacífico", "ElectroHogar", "Moda Quito"],
    "transport": ["Uber Trip", "Cabify", "Metrobus", "Gasolinera Petro"],
    "utilities": ["Servicios Luz", "Agua Municipal", "Internet Fibra", "Telefónica"],
    "health": ["Farmacia Sol", "Clínica Andes"],
    "deposit": ["Caja Matriz", "Ventanilla Norte", "ACH Nómina"],
    "investment": ["Póliza DPAC", "Depósito a Plazo", "Fondo Conservador"],
    "cash": ["ATM Centro", "ATM Mall", "Cajero Matriz"],
    "transfer": [],
    "adjustment": ["Reverso comisión", "Ajuste operacional", "Nota crédito interna"],
    "loan": ["Desembolso crédito", "Oficina Cartera"],
}

FIELDNAMES = [
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

INSUFFICIENT_VARIANTS = [
    ("37", "D", "AHO", "utilities"),
    ("71", "D", "AHO", "cash"),
    ("08", "D", "TJC", "shopping"),
    ("34", "D", "AHO", "transfer"),
    ("06", "D", "INV", "investment"),
]


@dataclass
class AccountRow:
    account_number: str
    holder_name: str
    balance: float


def load_accounts(database_url: str) -> list[AccountRow]:
    import psycopg2

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT account_number, holder_name, balance::float8 FROM accounts ORDER BY account_number"
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        raise SystemExit("No hay cuentas en accounts; corre el seed del API primero.")
    return [AccountRow(r[0], r[1], float(r[2])) for r in rows]


def weighted_template(rng: random.Random) -> tuple[str, str, str, str]:
    bag: list[tuple[str, str, str, str]] = []
    for tipo, nature, product, category, weight in TEMPLATES:
        bag.extend([(tipo, nature, product, category)] * weight)
    return rng.choice(bag)


def pick_date(rng: random.Random) -> str:
    start = date(2026, 8, 1)
    return (start + timedelta(days=rng.randint(0, 60))).isoformat()


def pick_counterpart(
    rng: random.Random,
    category: str,
    accounts: list[AccountRow],
    self_account: str,
) -> str:
    if category == "transfer":
        other = rng.choice(accounts)
        for _ in range(5):
            if other.account_number != self_account:
                break
            other = rng.choice(accounts)
        return other.holder_name
    options = MERCHANTS.get(category) or MERCHANTS["shopping"]
    base = rng.choice(options)
    if category == "investment":
        return f"{base}-{rng.randint(1, 999):03d}"
    return base


def nonexistent_account(rng: random.Random, existing: set[str]) -> str:
    for _ in range(50):
        candidate = f"ACC-{rng.randint(90_001, 99_999)}"
        if candidate not in existing:
            return candidate
    return "ACC-99999"


def money(amount: float) -> str:
    return f"{amount:.2f}"


def type_name_for(code: str) -> str:
    return TIPO_UAFE.get(code, code)


def generate_rows(accounts: list[AccountRow], count: int, seed: int) -> list[dict[str, str]]:
    rng = random.Random(seed)
    existing = {a.account_number for a in accounts}
    rows: list[dict[str, str]] = []

    outcomes = (
        ["COMPLETED"] * 68
        + ["CARD_DECLINED"] * 12
        + ["INSUFFICIENT_FUNDS"] * 10
        + ["ACCOUNT_NOT_FOUND"] * 10
    )

    for i in range(1, count + 1):
        outcome = rng.choice(outcomes)
        tipo, nature, product, category = weighted_template(rng)

        if outcome == "ACCOUNT_NOT_FOUND":
            account = nonexistent_account(rng, existing)
            balance = 0.0
            peer = rng.choice(accounts)
        else:
            acct = rng.choice(accounts)
            account = acct.account_number
            balance = acct.balance
            peer = acct

        if outcome == "INSUFFICIENT_FUNDS":
            base = max(balance, 1.0)
            amount = round(base + rng.uniform(50, 5_000), 2)
            status = "REJECTED"
            reason = "INSUFFICIENT_FUNDS"
            tipo, nature, product, category = rng.choice(INSUFFICIENT_VARIANTS)
        elif outcome == "CARD_DECLINED":
            if rng.random() < 0.7:
                tipo, nature, product = "37", "D", "TJC"
            else:
                tipo, nature, product = "08", "D", "TJC"
            if category not in ("food", "shopping", "transport"):
                category = "shopping"
            amount = round(rng.uniform(15, 400), 2)
            status = "REJECTED"
            reason = "CARD_DECLINED"
        elif outcome == "ACCOUNT_NOT_FOUND":
            amount = round(rng.uniform(10, 800), 2)
            status = "REJECTED"
            reason = "ACCOUNT_NOT_FOUND"
            if rng.random() < 0.5:
                tipo, nature, product, category = "34", "D", "AHO", "transfer"
            else:
                tipo, nature, product, category = "71", "D", "AHO", "cash"
        else:
            if nature == "C":
                amount = round(rng.uniform(20, 2_000), 2)
            elif product == "INV":
                amount = round(rng.uniform(100, 5_000), 2)
            else:
                cap = max(1.0, min(balance * 0.15, 1_500.0)) if balance > 0 else 50.0
                amount = round(rng.uniform(5, max(5.0, cap)), 2)
            status = "COMPLETED"
            reason = ""

        assert is_valid_combo(tipo, nature, product)
        counterpart = pick_counterpart(rng, category, accounts, account)
        if outcome == "ACCOUNT_NOT_FOUND":
            counterpart = peer.holder_name

        rows.append(
            {
                "uid": f"txn-{i:05d}",
                "account": account,
                "type_code": tipo,
                "type_name": type_name_for(tipo),
                "nature_code": nature,
                "product_code": product,
                "status": status,
                "amount": money(amount),
                "currency": "USD",
                "date": pick_date(rng),
                "counterpart_name": counterpart,
                "category": category,
                "reject_reason": reason,
            }
        )
    return rows


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def summarize(rows: list[dict[str, str]]) -> dict:
    status = Counter(r["status"] for r in rows)
    reasons = Counter(r["reject_reason"] for r in rows if r["reject_reason"])
    by_code = Counter(f"{r['type_code']} {r['type_name']}" for r in rows)
    return {
        "total": len(rows),
        "status": dict(status),
        "reject_reason": dict(reasons),
        "by_type_code": dict(by_code.most_common(12)),
        "infra_rows": 0,
        "has_event_class": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera transacciones crudas UAFE (pre-ETL, sin infra).")
    parser.add_argument("--count", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--database-url",
        default=os.environ.get(
            "DATABASE_URL",
            "postgresql://smartbancs:smartbancs@localhost:5432/smartbancs",
        ),
    )
    parser.add_argument("--out", type=Path, default=ROOT / "testdata" / "raw_transactions.csv")
    args = parser.parse_args()

    accounts = load_accounts(args.database_url)
    rows = generate_rows(accounts, args.count, args.seed)
    write_csv(args.out, rows)
    summary = summarize(rows)
    summary["accounts_read"] = len(accounts)
    summary["out"] = str(args.out)
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
