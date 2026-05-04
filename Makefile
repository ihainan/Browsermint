.PHONY: test test-backend test-frontend build test-fast test-e2e test-e2e-keep test-e2e-down docker-up docker-down

test: test-fast

test-backend:
	npm --prefix backend test

test-frontend:
	npm --prefix frontend test

build:
	npm --prefix backend run build
	npm --prefix frontend run build

test-fast:
	npm --prefix backend test
	npm --prefix backend run build
	npm --prefix frontend test
	npm --prefix frontend run build

test-e2e:
	python3 test_e2e.py

test-e2e-keep:
	python3 test_e2e.py --keep-session

test-e2e-down:
	python3 test_e2e.py --down-after

docker-up:
	cd docker && docker compose up -d --build

docker-down:
	cd docker && docker compose down
