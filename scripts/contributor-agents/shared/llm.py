"""LLM client wrapper — supports DeepSeek, Mistral, or any OpenAI-compatible API."""

import json
import logging
from openai import OpenAI

log = logging.getLogger(__name__)


class LLMClient:
    def __init__(self, api_key: str, base_url: str, model: str,
                 default_temperature: float = 0.7, default_max_tokens: int = 2000):
        self.client = OpenAI(api_key=api_key, base_url=base_url)
        self.model = model
        self.default_temperature = default_temperature
        self.default_max_tokens = default_max_tokens

    def ask(self, system_prompt: str, user_msg: str,
            temperature: float = None, max_tokens: int = None,
            json_mode: bool = False) -> str:
        kwargs = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            "temperature": temperature or self.default_temperature,
            "max_tokens": max_tokens or self.default_max_tokens,
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        resp = self.client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content

    def ask_json(self, system_prompt: str, user_msg: str, **kwargs) -> dict:
        raw = self.ask(system_prompt, user_msg, json_mode=True, **kwargs)
        return json.loads(raw)

    def ask_multi(self, messages: list[dict],
                  temperature: float = None, max_tokens: int = None) -> str:
        resp = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=temperature or self.default_temperature,
            max_tokens=max_tokens or self.default_max_tokens,
        )
        return resp.choices[0].message.content
