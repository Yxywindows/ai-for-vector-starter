"""Logging configuration: one JSON-ish line per record, request id when present."""

from __future__ import annotations

import logging
from logging.config import dictConfig

FORMAT = "%(asctime)s %(levelname)-8s %(name)s %(message)s"


def configure_logging(level: str) -> None:
    dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"default": {"format": FORMAT}},
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "default",
                    "stream": "ext://sys.stdout",
                }
            },
            "root": {"handlers": ["console"], "level": level.upper()},
            "loggers": {
                "uvicorn.access": {"handlers": ["console"], "level": "INFO", "propagate": False},
                "sqlalchemy.engine": {"level": "WARNING"},
            },
        }
    )
    logging.getLogger(__name__).debug("Logging configured at %s", level)
