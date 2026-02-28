.PHONY: install lint format test check up down restart

install:
	uv pip install -e ".[dev]"

lint:
	uv run ruff check tmuxdeck_bridge/ tests/

format:
	uv run ruff format tmuxdeck_bridge/ tests/
	uv run ruff check --fix tmuxdeck_bridge/ tests/

test:
	uv run pytest tests/ -v

check: lint test

up:
	docker compose up -d --build

down:
	docker compose down

restart:
	docker compose restart
