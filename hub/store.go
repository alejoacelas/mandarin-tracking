package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT UNIQUE,
  created_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '', permissions TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS intervals (
  device_id TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, language TEXT NOT NULL,
  zh_share REAL, units INTEGER, app TEXT NOT NULL, title TEXT, channel_name TEXT,
  channel_id TEXT, video_id TEXT, conversation_id TEXT, doc_id TEXT, url TEXT, meta TEXT,
  received_ms INTEGER NOT NULL, PRIMARY KEY (device_id, id));
CREATE INDEX IF NOT EXISTS intervals_time ON intervals (start_ms, end_ms);
CREATE TABLE IF NOT EXISTS chat_messages (
  service TEXT NOT NULL, message_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL, role TEXT NOT NULL, zh_share REAL NOT NULL, units INTEGER NOT NULL,
  PRIMARY KEY (service, message_id));
CREATE INDEX IF NOT EXISTS chat_messages_time ON chat_messages (service, at_ms);
CREATE TABLE IF NOT EXISTS channels (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, channel_id TEXT, label TEXT NOT NULL,
  decided_by TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
  updated_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS problems (
  device_id TEXT NOT NULL, component TEXT NOT NULL, message TEXT NOT NULL,
  at_ms INTEGER NOT NULL, PRIMARY KEY (device_id, component));
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

type Store struct {
	db *sql.DB
	mu sync.Mutex // serialises writes; SQLite allows one writer
}

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("creating tables: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Key-value settings and state.

func (s *Store) Get(key string) string {
	var v string
	_ = s.db.QueryRow(`SELECT value FROM kv WHERE key=?`, key).Scan(&v)
	return v
}

func (s *Store) Set(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// Devices.

type Device struct {
	ID, Name, Kind, Version, Permissions string
	CreatedMs, LastSeenMs                int64
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (s *Store) AddDevice(name, kind string, now int64) (id, token string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, token = kind+"-"+randomHex(6), randomHex(24)
	_, err = s.db.Exec(`INSERT INTO devices(id,name,kind,token_hash,created_ms,last_seen_ms) VALUES(?,?,?,?,?,?)`,
		id, name, kind, hashToken(token), now, now)
	return
}

// DeviceForToken returns "" when the token is unknown.
func (s *Store) DeviceForToken(token string) string {
	if token == "" {
		return ""
	}
	var id string
	_ = s.db.QueryRow(`SELECT id FROM devices WHERE token_hash=?`, hashToken(token)).Scan(&id)
	return id
}

func (s *Store) Touch(deviceID string, now int64, version, permissions string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if version == "" {
		_, err := s.db.Exec(`UPDATE devices SET last_seen_ms=? WHERE id=?`, now, deviceID)
		return err
	}
	_, err := s.db.Exec(`UPDATE devices SET last_seen_ms=?, version=?, permissions=? WHERE id=?`, now, version, permissions, deviceID)
	return err
}

func (s *Store) Devices() ([]Device, error) {
	rows, err := s.db.Query(`SELECT id,name,kind,version,permissions,created_ms,last_seen_ms FROM devices WHERE token_hash IS NOT NULL ORDER BY created_ms`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.Name, &d.Kind, &d.Version, &d.Permissions, &d.CreatedMs, &d.LastSeenMs); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ForgetDevice revokes a device's token. Its data stays.
func (s *Store) ForgetDevice(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE devices SET token_hash=NULL WHERE id=?`, id)
	return err
}

// Intervals.

type Interval struct {
	DeviceID       string   `json:"-"`
	ID             string   `json:"id"`
	Source         string   `json:"source"`
	StartMs        int64    `json:"start_ms"`
	EndMs          int64    `json:"end_ms"`
	Language       string   `json:"language"`
	ZhShare        *float64 `json:"zh_share"`
	Units          *int64   `json:"units"`
	App            string   `json:"app"`
	Title          *string  `json:"title"`
	ChannelName    *string  `json:"channel_name"`
	ChannelID      *string  `json:"channel_id"`
	VideoID        *string  `json:"video_id"`
	ConversationID *string  `json:"conversation_id"`
	DocID          *string  `json:"doc_id"`
	URL            *string  `json:"url"`
	Meta           *string  `json:"-"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *Store) UpsertIntervals(ivs []Interval, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	st, err := tx.Prepare(`INSERT INTO intervals(device_id,id,source,start_ms,end_ms,language,zh_share,units,app,title,channel_name,channel_id,video_id,conversation_id,doc_id,url,meta,received_ms)
	  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
	  ON CONFLICT(device_id,id) DO UPDATE SET source=excluded.source,start_ms=excluded.start_ms,end_ms=excluded.end_ms,
	  language=excluded.language,zh_share=excluded.zh_share,units=excluded.units,app=excluded.app,title=excluded.title,
	  channel_name=excluded.channel_name,channel_id=excluded.channel_id,video_id=excluded.video_id,
	  conversation_id=excluded.conversation_id,doc_id=excluded.doc_id,url=excluded.url,meta=excluded.meta,received_ms=excluded.received_ms`)
	if err != nil {
		return err
	}
	defer st.Close()
	for _, iv := range ivs {
		if _, err := st.Exec(iv.DeviceID, iv.ID, iv.Source, iv.StartMs, iv.EndMs, iv.Language, iv.ZhShare, iv.Units, iv.App,
			iv.Title, iv.ChannelName, iv.ChannelID, iv.VideoID, iv.ConversationID, iv.DocID, iv.URL, iv.Meta, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// IntervalsBetween returns intervals overlapping [from, to).
func (s *Store) IntervalsBetween(from, to int64) ([]Interval, error) {
	rows, err := s.db.Query(`SELECT device_id,id,source,start_ms,end_ms,language,zh_share,units,app,title,channel_name,channel_id,video_id,conversation_id,doc_id,url
	  FROM intervals WHERE start_ms < ? AND end_ms > ? ORDER BY start_ms`, to, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Interval
	for rows.Next() {
		var iv Interval
		if err := rows.Scan(&iv.DeviceID, &iv.ID, &iv.Source, &iv.StartMs, &iv.EndMs, &iv.Language, &iv.ZhShare, &iv.Units, &iv.App,
			&iv.Title, &iv.ChannelName, &iv.ChannelID, &iv.VideoID, &iv.ConversationID, &iv.DocID, &iv.URL); err != nil {
			return nil, err
		}
		out = append(out, iv)
	}
	return out, rows.Err()
}

// Chat messages.

type ChatMessage struct {
	Service        string  `json:"service"`
	ConversationID string  `json:"conversation_id"`
	MessageID      string  `json:"message_id"`
	AtMs           int64   `json:"at_ms"`
	Role           string  `json:"role"`
	ZhShare        float64 `json:"zh_share"`
	Units          int64   `json:"units"`
}

func (s *Store) UpsertChatMessages(ms []ChatMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, m := range ms {
		if _, err := tx.Exec(`INSERT INTO chat_messages(service,message_id,conversation_id,at_ms,role,zh_share,units) VALUES(?,?,?,?,?,?,?)
		  ON CONFLICT(service,message_id) DO UPDATE SET conversation_id=excluded.conversation_id,at_ms=excluded.at_ms,role=excluded.role,zh_share=excluded.zh_share,units=excluded.units`,
			m.Service, m.MessageID, m.ConversationID, m.AtMs, m.Role, m.ZhShare, m.Units); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ChatMessagesBetween(from, to int64) ([]ChatMessage, error) {
	rows, err := s.db.Query(`SELECT service,conversation_id,message_id,at_ms,role,zh_share,units FROM chat_messages WHERE at_ms >= ? AND at_ms < ? ORDER BY at_ms`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatMessage
	for rows.Next() {
		var m ChatMessage
		if err := rows.Scan(&m.Service, &m.ConversationID, &m.MessageID, &m.AtMs, &m.Role, &m.ZhShare, &m.Units); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// YouTube channels.

type Channel struct {
	Key, Name, ChannelID, Label, DecidedBy, Reason, LastError string
	Attempts                                                  int
	UpdatedMs                                                 int64
}

// ChannelKey identifies a channel by its display name, because Android's media session gives
// only the name.
func ChannelKey(name string) string { return strings.ToLower(strings.Join(strings.Fields(name), " ")) }

// NoteChannel records a channel seen in an interval, as pending if it's new.
func (s *Store) NoteChannel(name, channelID string, now int64) error {
	key := ChannelKey(name)
	if key == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO channels(key,name,channel_id,label,updated_ms) VALUES(?,?,?,'pending',?)
	  ON CONFLICT(key) DO UPDATE SET channel_id=COALESCE(NULLIF(excluded.channel_id,''),channels.channel_id)`, key, name, channelID, now)
	return err
}

func (s *Store) SetChannelLabel(key, label, decidedBy, reason string, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE channels SET label=?, decided_by=?, reason=?, last_error='', updated_ms=? WHERE key=?`, label, decidedBy, reason, now, key)
	return err
}

func (s *Store) ChannelFailed(key, msg string, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE channels SET attempts=attempts+1, last_error=?, updated_ms=? WHERE key=?`, msg, now, key)
	return err
}

func (s *Store) Channels(where string, args ...any) ([]Channel, error) {
	q := `SELECT key,name,COALESCE(channel_id,''),label,decided_by,reason,attempts,last_error,updated_ms FROM channels`
	if where != "" {
		q += " WHERE " + where
	}
	rows, err := s.db.Query(q+" ORDER BY updated_ms DESC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Channel
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.Key, &c.Name, &c.ChannelID, &c.Label, &c.DecidedBy, &c.Reason, &c.Attempts, &c.LastError, &c.UpdatedMs); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ChannelLabels() (map[string]string, error) {
	cs, err := s.Channels("")
	if err != nil {
		return nil, err
	}
	m := make(map[string]string, len(cs))
	for _, c := range cs {
		m[c.Key] = c.Label
	}
	return m, nil
}

// ChannelTitles returns the video titles seen for a channel, newest first.
func (s *Store) ChannelTitles(key string, limit int) ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT title FROM intervals WHERE source='youtube' AND title IS NOT NULL AND title<>'' AND lower(channel_name)=? ORDER BY start_ms DESC LIMIT ?`, key, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Problems.

type Problem struct {
	DeviceID, Component, Message string
	AtMs                         int64
}

func (s *Store) SetProblem(deviceID, component, message string, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if message == "" {
		_, err := s.db.Exec(`DELETE FROM problems WHERE device_id=? AND component=?`, deviceID, component)
		return err
	}
	_, err := s.db.Exec(`INSERT INTO problems(device_id,component,message,at_ms) VALUES(?,?,?,?)
	  ON CONFLICT(device_id,component) DO UPDATE SET message=excluded.message, at_ms=excluded.at_ms`, deviceID, component, message, now)
	return err
}

func (s *Store) Problems() ([]Problem, error) {
	rows, err := s.db.Query(`SELECT device_id,component,message,at_ms FROM problems ORDER BY at_ms DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Problem
	for rows.Next() {
		var p Problem
		if err := rows.Scan(&p.DeviceID, &p.Component, &p.Message, &p.AtMs); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

var errNotFound = errors.New("not found")
