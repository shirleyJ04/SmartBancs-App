from __future__ import annotations

TIPO_UAFE: dict[str, str] = {
    "01": "Compra de divisas",
    "02": "Venta de divisas",
    "03": "Depósito",
    "06": "Inversión",
    "07": "Renovación de inversión",
    "08": "Pago tarjeta de crédito",
    "11": "Concesión de préstamo",
    "12": "Cancelación de inversión",
    "13": "Cancelación / abono al préstamo",
    "21": "Transferencia misma institución",
    "34": "Transferencia nacional enviada",
    "35": "Transferencia nacional recibida",
    "36": "Nota de Crédito",
    "37": "Nota de Débito",
    "71": "Retiro",
    "72": "Pago cheque",
}

PRODUCTO: dict[str, str] = {
    "AHO": "Cuenta de ahorros",
    "CTE": "Cuenta corriente",
    "TJC": "Tarjeta de crédito",
    "INV": "Inversión",
    "RDI": "Renovación de inversión",
    "PRE": "Préstamo",
    "PRQ": "Préstamo quirografario",
    "PRH": "Préstamo hipotecario",
}

PRODUCTO_TIPOS: dict[str, set[str]] = {
    "AHO": {"03", "21", "34", "35", "36", "37", "71"},
    "CTE": {"03", "21", "34", "35", "36", "37", "71", "72"},
    "TJC": {"08", "37"},
    "INV": {"06", "07", "12"},
    "RDI": {"06", "07", "12"},
    "PRE": {"11", "13"},
    "PRQ": {"11", "13"},
    "PRH": {"11", "13"},
}

NATURALEZA = {"D", "C"}

BUSINESS_TIPOS = set(TIPO_UAFE.keys())


def normalize_tipo(value: object) -> str | None:
    text = str(value or "").strip().upper()
    if not text:
        return None
    if text.isdigit():
        text = text.zfill(2)
    return text if text in TIPO_UAFE else None


def label_for(tipo: str, nature: str, product: str) -> str:
    tipo_name = TIPO_UAFE.get(tipo, tipo)
    product_name = PRODUCTO.get(product, product)
    side = "Débito" if nature == "D" else "Crédito"
    return f"{tipo} {tipo_name} | {nature} {side} | {product} {product_name}"


def is_valid_combo(tipo: str, nature: str, product: str) -> bool:
    if tipo not in TIPO_UAFE or nature not in NATURALEZA or product not in PRODUCTO:
        return False
    allowed = PRODUCTO_TIPOS.get(product)
    return allowed is None or tipo in allowed
