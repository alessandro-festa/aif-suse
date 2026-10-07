# AI Factory's Ray Serve app: a Hugging Face chat model through transformers, behind the part of
# OpenAI's API clients need (GET /v1/models, POST /v1/chat/completions, no streaming). One model
# per replica, on the GPU when the replica has one. Configured by the RayService's runtime env.
import os
import time
import uuid

from fastapi import FastAPI
from ray import serve

MODEL = os.environ["MODEL_ID"]
NAME = os.environ.get("SERVED_NAME") or MODEL
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "256"))

api = FastAPI()


@serve.deployment
@serve.ingress(api)
class Chat:
    def __init__(self):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "1")))
        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.tok = AutoTokenizer.from_pretrained(MODEL)
        dtype = torch.float16 if self.device == "cuda" else torch.float32
        self.model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=dtype).to(self.device).eval()

    @api.get("/v1/models")
    def models(self):
        return {"object": "list", "data": [{"id": NAME, "object": "model", "owned_by": "ray-serve"}]}

    @api.post("/v1/chat/completions")
    def chat(self, body: dict):
        ids = self.tok.apply_chat_template(body.get("messages", []), add_generation_prompt=True, return_tensors="pt").to(self.device)
        temperature = float(body.get("temperature") or 0)
        kwargs = {"max_new_tokens": min(int(body.get("max_tokens") or MAX_TOKENS), MAX_TOKENS), "pad_token_id": self.tok.eos_token_id}
        kwargs.update({"do_sample": True, "temperature": temperature} if temperature > 0 else {"do_sample": False})
        with self.torch.no_grad():
            out = self.model.generate(ids, **kwargs)
        new = out[0][ids.shape[1]:]
        return {
            "id": "chatcmpl-" + uuid.uuid4().hex, "object": "chat.completion", "created": int(time.time()), "model": NAME,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": self.tok.decode(new, skip_special_tokens=True)},
                         "finish_reason": "length" if len(new) >= kwargs["max_new_tokens"] else "stop"}],
            "usage": {"prompt_tokens": int(ids.shape[1]), "completion_tokens": int(len(new)), "total_tokens": int(out.shape[1])},
        }


app = Chat.bind()
