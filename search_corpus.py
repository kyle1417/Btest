import argparse
import json
from pathlib import Path

import faiss
import numpy as np
from fastembed import TextEmbedding

BASE = Path(__file__).resolve().parent
CORPUS = BASE / "corpus"
INDEX_PATH = CORPUS / "faiss" / "index.faiss"
META_PATH = CORPUS / "faiss" / "metadata.json"
MODEL_INFO = CORPUS / "embedding_model.txt"


def load_model_name():
    text = MODEL_INFO.read_text(encoding="utf-8")
    for line in text.splitlines():
        if line.startswith("model_name="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("embedding model info not found")


def main():
    parser = argparse.ArgumentParser(description="检索 RAG 语料库")
    parser.add_argument("query", help="查询文本")
    parser.add_argument("-k", "--top-k", type=int, default=5)
    args = parser.parse_args()

    model_name = load_model_name()
    model = TextEmbedding(model_name=model_name)
    index = faiss.read_index(str(INDEX_PATH))
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))

    vec = np.array(list(model.embed([args.query])), dtype="float32")
    scores, indices = index.search(vec, args.top_k)

    result = []
    seen = set()
    for score, idx in zip(scores[0], indices[0]):
        if idx < 0:
            continue
        item = dict(meta[idx])
        key = (item.get("doc_title"), item.get("article"), item.get("text"))
        if key in seen:
            continue
        seen.add(key)
        item["score"] = float(score)
        result.append(item)
        if len(result) >= args.top_k:
            break

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
