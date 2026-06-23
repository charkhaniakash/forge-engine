from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    agent_port: int = 8000
    backend_url: str = "http://backend:8080"
    log_level: str = "info"

    class Config:
        env_file = ".env.local"
        env_file_encoding = "utf-8"


settings = Settings()