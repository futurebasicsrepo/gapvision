"""Mock Gap Inc. CRM layer.

In production this is PostgreSQL. For the simulator it is an in-memory
dataset shaped like the real thing, so the API contract survives the swap.
Guests are identified ONLY by opt-in app/beacon signals (guest_id), never
by facial recognition.
"""

GUESTS = {
    "guest-001": {
        "guest_id": "guest-001",
        "name": "Sarah Chen",
        "loyalty_tier": "Icon",
        "loyalty_points": 4200,
        "sizes": {"tops": "M", "bottoms": "28x30", "outerwear": "M"},
        "persona_tags": ["minimalist", "denim-core", "neutral-palette"],
        "purchase_history": [
            {"sku": "GAP-DNM-0412", "name": "Mid Rise Vintage Slim Jeans", "price": 79.95},
            {"sku": "GAP-TEE-1108", "name": "Organic Cotton Vintage Tee", "price": 24.95},
            {"sku": "GAP-JKT-2203", "name": "Icon Denim Jacket", "price": 98.00},
        ],
        "open_cart_online": [
            {"sku": "GAP-SWT-3310", "name": "CashSoft Crew Sweater", "price": 69.95}
        ],
    },
    "guest-002": {
        "guest_id": "guest-002",
        "name": "Marcus Webb",
        "loyalty_tier": "Enthusiast",
        "loyalty_points": 860,
        "sizes": {"tops": "XL", "bottoms": "36x32", "outerwear": "XL"},
        "persona_tags": ["athleisure", "logo-forward", "earth-tones"],
        "purchase_history": [
            {"sku": "GAP-HOD-5501", "name": "Vintage Soft Arch Logo Hoodie", "price": 59.95},
            {"sku": "GAP-JOG-5620", "name": "Vintage Soft Joggers", "price": 49.95},
        ],
        "open_cart_online": [],
    },
    "guest-003": {
        "guest_id": "guest-003",
        "name": "Priya Nair",
        "loyalty_tier": "Core",
        "loyalty_points": 120,
        "sizes": {"tops": "S", "bottoms": "26x28", "outerwear": "S"},
        "persona_tags": ["workwear", "tailored", "color-pop"],
        "purchase_history": [
            {"sku": "GAP-TRS-7702", "name": "365 High Rise Trousers", "price": 89.95}
        ],
        "open_cart_online": [
            {"sku": "GAP-BLZ-7810", "name": "Relaxed Linen Blazer", "price": 128.00},
            {"sku": "GAP-SHT-7844", "name": "Poplin Shirt", "price": 54.95},
        ],
    },
}

# Live floor inventory the recommendation engine can pull from.
#
# `sizes` is the variant-level breakdown a real inventory API returns and the
# voice engine needs to answer "do we have these in a 32". It is optional:
# providers without variant data (the Shopify adapter today) omit it and the
# answer degrades honestly to floor totals rather than guessing a size.
INVENTORY = [
    {"sku": "GAP-SWT-3310", "name": "CashSoft Crew Sweater", "price": 69.95,
     "tags": ["minimalist", "neutral-palette"], "location": "Front Table 2", "stock": 14,
     "sizes": {"XS": 1, "S": 4, "M": 5, "L": 3, "XL": 1}},
    {"sku": "GAP-DNM-0498", "name": "High Rise Barrel Jeans", "price": 89.95,
     "tags": ["denim-core", "minimalist"], "location": "Denim Wall", "stock": 9,
     "sizes": {"26x28": 1, "28x30": 3, "30x30": 2, "32x30": 3, "34x32": 0}},
    {"sku": "GAP-HOD-5502", "name": "Heavyweight Logo Hoodie", "price": 69.95,
     "tags": ["athleisure", "logo-forward"], "location": "Active Zone", "stock": 22,
     "sizes": {"S": 3, "M": 7, "L": 8, "XL": 4, "XXL": 0}},
    {"sku": "GAP-JOG-5688", "name": "Utility Cargo Joggers", "price": 64.95,
     "tags": ["athleisure", "earth-tones"], "location": "Active Zone", "stock": 11,
     "sizes": {"S": 2, "M": 4, "L": 3, "XL": 2}},
    {"sku": "GAP-BLZ-7810", "name": "Relaxed Linen Blazer", "price": 128.00,
     "tags": ["workwear", "tailored"], "location": "New Arrivals", "stock": 6,
     "sizes": {"XS": 1, "S": 2, "M": 2, "L": 1}},
    {"sku": "GAP-SHT-7844", "name": "Poplin Shirt", "price": 54.95,
     "tags": ["workwear", "color-pop", "tailored"], "location": "New Arrivals", "stock": 17,
     "sizes": {"XS": 2, "S": 5, "M": 6, "L": 3, "XL": 1}},
    {"sku": "GAP-TEE-1150", "name": "Heavyweight Relaxed Tee", "price": 29.95,
     "tags": ["minimalist", "neutral-palette", "athleisure"], "location": "Essentials", "stock": 31,
     "sizes": {"XS": 4, "S": 8, "M": 9, "L": 7, "XL": 3}},
]


def get_guest(guest_id: str):
    return GUESTS.get(guest_id)


def all_guests():
    return list(GUESTS.values())
