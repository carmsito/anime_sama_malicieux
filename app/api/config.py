from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.parent
EXTRACTION_DIR = PROJECT_ROOT / "extraction"
COVERS_DIR = Path(__file__).parent / "data" / "covers"
USERS_FILE = Path(__file__).parent / "data" / "users.json"
JOBS_FILE = Path(__file__).parent / "data" / "jobs.json"

SECRET_KEY = "change-me-in-production-use-a-long-random-string"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

COVERS_DIR.mkdir(parents=True, exist_ok=True)
