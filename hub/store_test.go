package main

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// A database from the first test installs (no channel_key) opens, gains the column and keeps
// its data.
func TestMigrateOldDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE intervals (
	  device_id TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL,
	  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, language TEXT NOT NULL,
	  zh_share REAL, units INTEGER, app TEXT NOT NULL, title TEXT, channel_name TEXT,
	  channel_id TEXT, video_id TEXT, conversation_id TEXT, doc_id TEXT, url TEXT, meta TEXT,
	  received_ms INTEGER NOT NULL, PRIMARY KEY (device_id, id));
	  INSERT INTO intervals VALUES('d','1','youtube',1,2,'unknown',NULL,NULL,'x','t','LaoGao',NULL,NULL,NULL,NULL,NULL,NULL,0);`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	st, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	titles, err := st.ChannelTitles("laogao", 5)
	if err != nil || len(titles) != 1 {
		t.Fatalf("titles %v err %v", titles, err)
	}
	st.Close()
	// Opening again is a no-op.
	st, err = OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
}
