# models.py
from sqlalchemy import Column, Integer, String, DateTime, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime, timezone
import secrets

Base = declarative_base()

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    friend_code = Column(String, unique=True, index=True)
    last_seen = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    avatar_url = Column(String, default="/static/default-avatar.png")  # URL аватарки
    bio = Column(String, default="")  # Описание

    def generate_friend_code(self):
        self.friend_code = secrets.token_urlsafe(6)[:8].upper().replace("-", "X").replace("_", "Y")

class Message(Base):
    __tablename__ = 'messages'
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, index=True)
    text = Column(String)
    timestamp = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    chat_id = Column(String, index=True)

# Создаём таблицы
engine = create_engine("sqlite:///./chat.db", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)