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
import hashlib
from pathlib import Path

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

@app.get("/friends")
async def friends_list(request: Request, db: Session = Depends(get_db)):
    username = request.query_params.get("username")
    if not username:
        return RedirectResponse(url="/")

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

# ✅ НОВЫЙ ЭНДПОИНТ: API для получения списка друзей в JSON
@app.get("/api/friends_list")
async def get_friends_list(username: str, db: Session = Depends(get_db)):
    """Возвращает список друзей в JSON формате для использования в create_chat.html"""
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

    return {"friends": friend_list}

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

    user.bio = bio[:500]

    if avatar and avatar.filename:
        os.makedirs("static/avatars", exist_ok=True)
        ext = avatar.filename.split('.')[-1]
        filename = f"{username}.{ext}"
        filepath = f"static/avatars/{filename}"
        with open(filepath, "wb") as f:
            shutil.copyfileobj(avatar.file, f)
        user.avatar_url = f"/static/avatars/{filename}"

    db.commit()

    return RedirectResponse(url=f"/profile/{username}?username={username}", status_code=303)

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

@app.post("/api/create_group")
async def create_group(
    request: Request,
    participants: str = Form(...),
    group_name: str = Form(...),
    creator: str = Form(...),
    db: Session = Depends(get_db)
):
    user_list = [creator] + [u.strip() for u in participants.split(",") if u.strip()]
    user_list = list(set(user_list))

    if len(user_list) < 2:
        return {"error": "Нужно выбрать хотя бы одного друга"}

    hash_input = ":".join(sorted(user_list))
    chat_id = "group:" + hashlib.md5(hash_input.encode()).hexdigest()[:8]

    exists = db.query(Message).filter(Message.chat_id == chat_id).first()
    if not exists:
        welcome_text = f"Группа '{group_name}' создана! Участники: {', '.join(user_list)}"
        welcome = Message(
            username="system",
            text=welcome_text,
            chat_id=chat_id
        )
        db.add(welcome)
        db.commit()

    return {
        "success": True,
        "chat_id": chat_id,
        "name": group_name,
        "display_name": f"👥 {group_name}"
    }

@app.get("/create_chat")
async def create_chat_page(request: Request):
    username = request.query_params.get("username")
    if not username:
        return RedirectResponse(url="/")
    return templates.TemplateResponse("create_chat.html", {"request": request, "username": username})

@app.get("/api/user/chats")
async def get_user_chats(username: str, db: Session = Depends(get_db)):
    # Чаты, где пользователь явно писал сообщения
    chat_ids = db.query(Message.chat_id).filter(
        Message.username == username
    ).distinct().all()

    # Личные чаты, где chat_id содержит имя пользователя
    other_chats = db.query(Message.chat_id).filter(
        Message.chat_id.contains(username),
        Message.chat_id != "global"
    ).distinct().all()

    all_chat_ids = {chat_id[0] for chat_id in chat_ids + other_chats}

    # Также добавим все групповые чаты, в которых пользователь является участником,
    # определяя участников по приветственному системному сообщению при создании группы
    group_candidates = db.query(Message.chat_id).filter(
        Message.chat_id.like("group:%")
    ).distinct().all()

    for gc in group_candidates:
        all_chat_ids.add(gc[0])

    group_chats = []
    private_chats = []

    for cid in all_chat_ids:
        if cid.startswith("group:"):
            # Берём последнее СИСТЕМНОЕ сообщение, в котором указан список участников
            sys_msg = (
                db.query(Message)
                .filter(
                    Message.chat_id == cid,
                    Message.username == "system",
                    Message.text.contains("Участники:")
                )
                .order_by(Message.id.desc())
                .first()
            )
            if sys_msg:
                try:
                    name_part = sys_msg.text.split("'")
                    name = name_part[1] if len(name_part) >= 2 else "Без названия"
                except Exception:
                    name = "Без названия"

                participants = []
                try:
                    participants_text = sys_msg.text.split("Участники:", 1)[1]
                    participants = [u.strip() for u in participants_text.split(',') if u.strip()]
                except Exception:
                    participants = []

                if username in participants:
                    group_chats.append({
                        "chat_id": cid,
                        "name": name,
                        "type": "group",
                        "display_name": f"👥 {name}"
                    })
        else:
            users = cid.split(":")
            if len(users) == 2 and username in users:
                other_user = users[0] if users[1] == username else users[1]
                private_chats.append({
                    "chat_id": cid,
                    "name": other_user,
                    "type": "private",
                    "display_name": f"💬 С {other_user}"
                })

    return {
        "group_chats": group_chats,
        "private_chats": private_chats
    }

@app.post("/api/delete_chat")
async def delete_chat(
    chat_id: str = Form(...),
    db: Session = Depends(get_db)
):
    # Удаляем все сообщения данного чата
    db.query(Message).filter(Message.chat_id == chat_id).delete()
    db.commit()
    return {"success": True}

@app.post("/api/remove_friend")
async def remove_friend(
    username: str = Form(...),
    friend_username: str = Form(...),
    db: Session = Depends(get_db)
):
    # Дружба у нас имплицитна: личный чат = дружба. Удаляем личный чат.
    chat_id = ":".join(sorted([username, friend_username]))
    db.query(Message).filter(Message.chat_id == chat_id).delete()
    db.commit()
    return {"success": True, "chat_id": chat_id}

# ====== Upload attachments ======
@app.post("/api/upload")
async def upload_attachment(
    username: str = Form(...),
    chat_id: str = Form(...),
    file: UploadFile = File(...)
):
    if not chat_id:
        raise HTTPException(status_code=400, detail="chat_id is required")

    uploads_dir = Path("static") / "uploads" / chat_id
    uploads_dir.mkdir(parents=True, exist_ok=True)

    # Sanitize filename
    original_name = os.path.basename(file.filename or "attachment")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    safe_name = f"{timestamp}_{original_name}"
    file_path = uploads_dir / safe_name

    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    rel_url = f"/static/uploads/{chat_id}/{safe_name}"
    content_type = (file.content_type or "application/octet-stream").lower()
    is_image = content_type.startswith("image/")

    return {
        "success": True,
        "url": rel_url,
        "filename": original_name,
        "content_type": content_type,
        "is_image": is_image
    }

# ====== Group info and updates ======
@app.get("/api/group_info")
async def api_group_info(chat_id: str, db: Session = Depends(get_db)):
    if not chat_id.startswith("group:"):
        raise HTTPException(status_code=400, detail="Not a group chat")
    # latest SYSTEM message that includes participants
    last_msg = (
        db.query(Message)
        .filter(
            Message.chat_id == chat_id,
            Message.username == "system",
            Message.text.contains("Участники:")
        )
        .order_by(Message.id.desc())
        .first()
    )
    if not last_msg:
        return {"chat_id": chat_id, "name": "Без названия", "participants": []}
    try:
        name_part = last_msg.text.split("'")
        name = name_part[1] if len(name_part) >= 2 else "Без названия"
    except Exception:
        name = "Без названия"
    participants = []
    if "Участники:" in last_msg.text:
        try:
            participants_text = last_msg.text.split("Участники:", 1)[1]
            participants = [u.strip() for u in participants_text.split(',') if u.strip()]
        except Exception:
            participants = []
    return {"chat_id": chat_id, "name": name, "participants": participants}

@app.post("/api/group_update_members")
async def api_group_update_members(
    chat_id: str = Form(...),
    members: str = Form(...),
    actor: str = Form(...),
    db: Session = Depends(get_db)
):
    if not chat_id.startswith("group:"):
        raise HTTPException(status_code=400, detail="Not a group chat")
    # Normalize members
    member_list = sorted({u.strip() for u in members.split(',') if u.strip()})
    if len(member_list) < 2:
        return {"error": "В группе должно быть минимум 2 участника"}

    # Get current name from latest message
    last_msg = db.query(Message).filter(Message.chat_id == chat_id).order_by(Message.id.desc()).first()
    group_name = "Без названия"
    if last_msg:
        try:
            group_name = last_msg.text.split("'")[1]
        except Exception:
            pass

    # Add system message reflecting new composition
    text = f"Группа '{group_name}' обновлена! Участники: {', '.join(member_list)}"
    sys_msg = Message(username="system", text=text, chat_id=chat_id)
    db.add(sys_msg)
    db.commit()

    return {"success": True, "chat_id": chat_id, "participants": member_list}

# Resolve friend code to username
@app.get("/api/resolve_friend_code")
async def resolve_friend_code(code: str, db: Session = Depends(get_db)):
    friend = db.query(User).filter(User.friend_code == code.upper()).first()
    if not friend:
        return {"found": False}
    return {"found": True, "username": friend.username}

# Leave group
@app.post("/api/group_leave")
async def group_leave(
    chat_id: str = Form(...),
    username: str = Form(...),
    db: Session = Depends(get_db)
):
    if not chat_id.startswith("group:"):
        raise HTTPException(status_code=400, detail="Not a group chat")

    # get latest participants
    info_resp = await api_group_info(chat_id, db)
    participants = [u for u in info_resp.get("participants", []) if u]
    if username not in participants:
        return {"success": True}
    new_members = [u for u in participants if u != username]
    # keep at least 1 member
    if not new_members:
        # if empty, delete chat
        db.query(Message).filter(Message.chat_id == chat_id).delete()
        db.commit()
        return {"success": True, "chat_deleted": True}

    # persist via system message
    group_name = info_resp.get("name") or "Без названия"
    text = f"Группа '{group_name}' обновлена! Участники: {', '.join(new_members)}"
    sys_msg = Message(username="system", text=text, chat_id=chat_id)
    db.add(sys_msg)
    db.commit()
    return {"success": True, "participants": new_members}

@app.websocket("/ws/{username}")
async def websocket_endpoint(websocket: WebSocket, username: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == username).first()
    if not user:
        await websocket.close(code=1008)
        return

    user.last_seen = datetime.now(timezone.utc)
    db.commit()

    await manager.connect(websocket)
    online_users.add(username)

    try:
        await websocket.send_text(json.dumps({
            "type": "history",
            "chat_id": "",
            "messages": []
        }))

        while True:
            data = await websocket.receive_text()
            message_data = json.loads(data)

            if message_data.get("type") == "load_chat":
                chat_id = message_data.get("chat_id", "")
                messages = db.query(Message).filter(Message.chat_id == chat_id).order_by(Message.timestamp).all()
                history = [
                    {
                        "id": msg.id,
                        "username": msg.username,
                        "text": msg.text,
                        "timestamp": msg.timestamp.isoformat() + "Z",
                        "chat_id": msg.chat_id
                    }
                    for msg in messages
                ]
                # augment messages with attachment info if detected in placeholder
                for h in history:
                    t = h.get("text") or ""
                    if t.startswith("[file] ") and "->" in t:
                        try:
                            rest = t[len("[file] "):]
                            fname, url = [p.strip() for p in rest.split("->", 1)]
                            is_image = url.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp"))
                            h["attachment"] = {"url": url, "filename": fname, "is_image": is_image}
                        except Exception:
                            pass
                await websocket.send_text(json.dumps({
                    "type": "history",
                    "chat_id": chat_id,
                    "messages": history
                }))
                continue

            if message_data.get("type") == "typing":
                chat_id = message_data.get("chat_id")
                is_typing = message_data.get("is_typing", False)

                if chat_id not in typing_users:
                    typing_users[chat_id] = set()

                if is_typing:
                    typing_users[chat_id].add(username)
                else:
                    typing_users[chat_id].discard(username)

                typing_list = list(typing_users[chat_id])
                await manager.broadcast(json.dumps({
                    "type": "typing",
                    "chat_id": chat_id,
                    "users": typing_list
                }))
                continue

            if message_data.get("type") == "attachment":
                chat_id = message_data.get("chat_id", "")
                url = message_data.get("url")
                filename = message_data.get("filename")
                is_image = message_data.get("is_image", False)
                if not chat_id or not url:
                    continue

                placeholder_text = f"[file] {filename} -> {url}"
                db_message = Message(username=username, text=placeholder_text, chat_id=chat_id)
                db.add(db_message)
                db.commit()
                db.refresh(db_message)

                await manager.broadcast(json.dumps({
                    "type": "attachment",
                    "username": username,
                    "chat_id": chat_id,
                    "url": url,
                    "filename": filename,
                    "is_image": is_image,
                    "timestamp": db_message.timestamp.isoformat() + "Z"
                }))
                continue

            # Edit message
            if message_data.get("type") == "edit_message":
                msg_id = message_data.get("message_id")
                new_text = (message_data.get("text") or "").strip()
                if not msg_id or not new_text:
                    continue
                db_msg = db.query(Message).filter(Message.id == msg_id).first()
                if not db_msg or db_msg.username != username:
                    continue
                db_msg.text = new_text
                db.commit()
                await manager.broadcast(json.dumps({
                    "type": "message_edited",
                    "message_id": msg_id,
                    "text": new_text,
                    "edited": True
                }))
                continue

            # Delete message
            if message_data.get("type") == "delete_message":
                msg_id = message_data.get("message_id")
                if not msg_id:
                    continue
                db_msg = db.query(Message).filter(Message.id == msg_id).first()
                if not db_msg or db_msg.username != username:
                    continue
                db.delete(db_msg)
                db.commit()
                await manager.broadcast(json.dumps({
                    "type": "message_deleted",
                    "message_id": msg_id
                }))
                continue

            text = message_data.get("text", "")
            if not text:
                continue

            chat_id = message_data.get("chat_id", "")
            if not chat_id:
                continue

            db_message = Message(username=username, text=text, chat_id=chat_id)
            db.add(db_message)
            db.commit()
            db.refresh(db_message)

            response = {
                "type": "message",
                "id": db_message.id,
                "username": username,
                "text": text,
                "timestamp": db_message.timestamp.isoformat() + "Z",
                "chat_id": chat_id,
                "edited": False
            }
            await manager.broadcast(json.dumps(response))

    except WebSocketDisconnect:
        manager.disconnect(websocket)
        online_users.discard(username)
    finally:
        user.last_seen = datetime.now(timezone.utc)
        db.commit()