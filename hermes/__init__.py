"""talkto-plugin for Hermes Agent. See README.md and plugin.py."""

from .plugin import TalkToPlugin


def register(ctx):
    """Hermes calls this once when the plugin loads."""
    TalkToPlugin(ctx).register()
