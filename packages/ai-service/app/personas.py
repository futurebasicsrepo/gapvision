"""Style persona matching.

Production design: embeddings in pgvector (or Pinecone) keyed by guest,
cosine-matched against product embeddings. The simulator uses weighted tag
overlap — same interface, swappable engine.
"""
def match_products(persona_tags: list[str], owned_skus: set[str],
                   inventory: list[dict], limit: int = 3):
    """Rank floor inventory against a guest's style persona."""
    scored = []
    for item in inventory:
        # Exclude items the guest already owns. Providers differ in their
        # identifier (mock: SKU codes; Shopify: line-item titles vs product
        # handles), so match on either sku or display name.
        if item["sku"] in owned_skus or item["name"] in owned_skus:
            continue
        overlap = len(set(item["tags"]) & set(persona_tags))
        if overlap == 0:
            continue
        # Light stock-awareness: prefer items we can actually sell.
        score = overlap + min(item["stock"], 20) / 100.0
        scored.append((score, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    if scored:
        return [item for _, item in scored[:limit]]

    # Fallback for sparse catalogs / first-visit guests: best in-stock items.
    unowned = [i for i in inventory
               if i["sku"] not in owned_skus and i["name"] not in owned_skus
               and i["stock"] > 0]
    unowned.sort(key=lambda i: i["stock"], reverse=True)
    return unowned[:limit]
