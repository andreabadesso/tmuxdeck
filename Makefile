.PHONY: build run screenshot

build:
	nix build

run:
	nix run

screenshot:
	cd frontend && npm run screenshot
