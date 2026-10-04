"""CLI and Python SDK for the AI Factory Scheduler: the same profiles, training runs and inference
endpoints as the Rancher UI extension, through the Kubernetes API with your own credentials."""

__version__ = "0.1.0"

from .client import Client  # noqa: E402
from .profiles import Profile, ProfileError  # noqa: E402

__all__ = ["Client", "Profile", "ProfileError", "__version__"]
