# main.py
from fastapi import FastAPI, Request, Depends, WebSocket, WebSocketDisconnect, HTTPException, Form, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import RedirectResponse
from typing import List
from models import Message, User
from database import get_db
from sqlalchemy.orm import Session
import json
import bcrypt
from datetime import datetime, timezone
import os
import shutil

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            await connection.send_text(message)

manager = ConnectionManager()
typing_users = {}
online_users = set()

@app.get("/")
async def get_login(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})

@app.post("/register")
async def register(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db)
):
    if not username or not password:
        return templates.TemplateResponse("login.html", {
            "request": request,
            "error": "Логин и пароль обязательны"
        })

    db_user = db.query(User).filter(User.username == username).first()
    if db_user:
        return templates.TemplateResponse("login.html", {
            "request": request,
            "error": "Пользователь уже существует"
        })

    hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
    new_user = User(username=username, hashed_password=hashed.decode('utf-8'))
    new_user.generate_friend_code()
    db.add(new_user)
    db.commit()

    return templates.TemplateResponse("login.html", {
        "request": request,
        "message": "Регистрация успешна! Теперь войдите."
    })

@app.post("/login")
async def login(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == username).first()
    if not user or not bcrypt.checkpw(password.encode('utf-8'), user.hashed_password.encode('utf-8')):
        return templates.TemplateResponse("login.html", {
            "request": request,
            "error": "Неверный логин или пароль"
        })

    response = RedirectResponse(url=f"/chat?username={username}", status_code=303)
    return response

@app.get("/chat")
async def get_chat(request: Request):
    username = request.query_params.get("username")
    if not username:
        return RedirectResponse(url="/")
    return templates.TemplateResponse("chat.html", {"request": request, "username": username})

# Список друзей
@app.get("/friends")
async def friends_list(request: Request, db: Session = Depends(get_db)):
    username = request.query_params.get("username")
    if not username:
        return RedirectResponse(url="/")

    # Находим всех друзей — у кого есть общий чат с текущим пользователем
    friend_chats = db.query(Message.chat_id).filter(
        Message.chat_id.contains(username),
        Message.chat_id != "global"
    ).distinct().all()

    friends = set()
    for chat_id in friend_chats:
        users = chat_id[0].split(":")
        for u in users:
            if u != username:
                friends.add(u)

    friend_list = []
    for friend_name in friends:
        friend = db.query(User).filter(User.username == friend_name).first()
        if friend:
            friend_list.append({
                "username": friend.username,
                "avatar_url": friend.avatar_url,
                "bio": friend.bio
            })

    return templates.TemplateResponse("friends.html", {
        "request": request,
        "username": username,
        "friends": friend_list
    })

# Просмотр профиля любого пользователя (включая себя)
@app.get("/profile/{target_username}")
async def view_profile(request: Request, target_username: str, db: Session = Depends(get_db)):
    username = request.query_params.get("username")
    if not username:
        return RedirectResponse(url="/")

    target_user = db.query(User).filter(User.username == target_username).first()
    if not target_user:
        return templates.TemplateResponse("error.html", {
            "request": request,
            "message": "Пользователь не найден"
        })

    is_self = (username == target_username)

    return templates.TemplateResponse("view_profile.html", {
        "request": request,
        "viewer": username,
        "profile": target_user,
        "is_self": is_self
    })

# Редактирование профиля
@app.get("/edit_profile")
async def edit_profile_page(request: Request, db: Session = Depends(get_db)):
    username = request.query_params.get("username")
    if not username:
        return RedirectResponse(url="/")

    user = db.query(User).filter(User.username == username).first()
    if not user:
        return RedirectResponse(url="/")

    return templates.TemplateResponse("edit_profile.html", {
        "request": request,
        "user": user
    })

@app.post("/edit_profile")
async def edit_profile(
    request: Request,
    bio: str = Form(""),
    avatar: UploadFile = File(None),
    username: str = Form(...),
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == username).first()
    if not user:
        return RedirectResponse(url="/")

    user.bio = bio[:500]  # Ограничим описание 500 символами

    if avatar and avatar.filename:
        # Создаём папку, если нет
        os.makedirs("static/avatars", exist_ok=True)
        # Генерируем уникальное имя файла
        ext = avatar.filename.split('.')[-1]
        filename = f"{username}.{ext}"
        filepath = f"static/avatars/{filename}"
        # Сохраняем файл
        with open(filepath, "wb") as f:
            shutil.copyfileobj(avatar.file, f)
        user.avatar_url = f"/static/avatars/{filename}"

    db.commit()

    return RedirectResponse(url=f"/profile/{username}?username={username}", status_code=303)

# Добавление в друзья
@app.post("/api/add_friend")
async def add_friend(
    request: Request,
    friend_code: str = Form(...),
    username: str = Form(...),
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == username).first()
    friend = db.query(User).filter(User.friend_code == friend_code).first()

    if not friend:
        return {"error": "Пользователь с таким кодом не найден"}

    if friend.username == username:
        return {"error": "Нельзя добавить себя"}

    chat_id = ":".join(sorted([username, friend.username]))
    exists = db.query(Message).filter(Message.chat_id == chat_id).first()
    if not exists:
        welcome = Message(
            username="system",
            text=f"Вы добавили {friend.username} в друзья!",
            chat_id=chat_id
        )
        db.add(welcome)
        db.commit()

    return {"success": True, "chat_id": chat_id, "friend": friend.username}

# Получение списка чатов пользователя
@app.get("/api/user/chats")
async def get_user_chats(username: str, db: Session = Depends(get_db)):
    chat_ids = db.query(Message.chat_id).filter(
        Message.username == username
    ).distinct().all()

    other_chats = db.query(Message.chat_id).filter(
        Message.chat_id.contains(username),
        Message.chat_id != "global"
    ).distinct().all()

    all_chat_ids = {chat_id[0] for chat_id in chat_ids + other_chats}

    chats = []
    for cid in all_chat_ids:
        if cid == "global":
            chats.append({"chat_id": "global", "name": "👥 Общий чат"})
        else:
            users = cid.split(":")
            if len(users) == 2:
                other_user = users[0] if users[1] == username else users[1]
                chats.append({"chat_id": cid, "name": f"💬 С {other_user}"})

    return {"chats": chats}

# WebSocket с друзьями, статусами и печатанием
@app.websocket("/ws/{username}")
async def websocket_endpoint(websocket: WebSocket, username: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == username).first()
    if not user:
        await websocket.close(code=1008)  # Policy Violation
        return

    # Обновляем last_seen → пользователь онлайн
    user.last_seen = datetime.now(timezone.utc)
    db.commit()

    await manager.connect(websocket)
    online_users.add(username)

    try:
        # Загружаем историю общего чата
        messages = db.query(Message).filter(Message.chat_id == "global").order_by(Message.timestamp).all()
        history = [
            {
                "username": msg.username,
                "text": msg.text,
                "timestamp": msg.timestamp.isoformat() + "Z",
                "chat_id": msg.chat_id
            }
            for msg in messages
        ]
        await websocket.send_text(json.dumps({
            "type": "history",
            "chat_id": "global",
            "messages": history
        }))

        while True:
            data = await websocket.receive_text()
            message_data = json.loads(data)

            if message_data.get("type") == "load_chat":
                chat_id = message_data.get("chat_id", "global")
                messages = db.query(Message).filter(Message.chat_id == chat_id).order_by(Message.timestamp).all()
                history = [
                    {
                        "username": msg.username,
                        "text": msg.text,
                        "timestamp": msg.timestamp.isoformat() + "Z",
                        "chat_id": msg.chat_id
                    }
                    for msg in messages
                ]
                await websocket.send_text(json.dumps({
                    "type": "history",
                    "chat_id": chat_id,
                    "messages": history
                }))
                continue

            # Обработка события "печатает..."
            if message_data.get("type") == "typing":
                chat_id = message_data.get("chat_id")
                is_typing = message_data.get("is_typing", False)

                if chat_id not in typing_users:
                    typing_users[chat_id] = set()

                if is_typing:
                    typing_users[chat_id].add(username)
                else:
                    typing_users[chat_id].discard(username)

                # Рассылаем событие "печатает..." всем в этом чате
                typing_list = list(typing_users[chat_id])
                await manager.broadcast(json.dumps({
                    "type": "typing",
                    "chat_id": chat_id,
                    "users": typing_list
                }))
                continue

            text = message_data.get("text", "")
            if not text:
                continue

            chat_id = message_data.get("chat_id", "global")
            db_message = Message(username=username, text=text, chat_id=chat_id)
            db.add(db_message)
            db.commit()
            db.refresh(db_message)

            response = {
                "type": "message",
                "username": username,
                "text": text,
                "timestamp": db_message.timestamp.isoformat() + "Z",
                "chat_id": chat_id
            }
            await manager.broadcast(json.dumps(response))

    except WebSocketDisconnect:
        manager.disconnect(websocket)
        online_users.discard(username)
    finally:
        # При отключении — обновляем last_seen
        user.last_seen = datetime.now(timezone.utc)
        db.commit()