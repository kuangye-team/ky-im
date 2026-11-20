use super::store::Store;
use serde::Deserialize;
use worker::*;

#[durable_object]
pub struct NumberDirectory {
    db: Store,
    limit: usize,
}
#[derive(Deserialize)]
struct Entry {
    id: String,
    sid: String,
    member: bool,
    add: bool,
}
#[derive(Deserialize)]
struct Id {
    id: String,
}
impl DurableObject for NumberDirectory {
    fn new(state: State, env: Env) -> Self {
        let limit = super::config(&env)
            .expect("configuration")
            .max_peers_per_room
            .min(128);
        let db = Store::new(state, env);
        db.state.storage().sql().exec("CREATE TABLE IF NOT EXISTS entries(id TEXT,member INTEGER,sid TEXT,PRIMARY KEY(id,member))",None).expect("directory");
        Self { db, limit }
    }
    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let sql = self.db.state.storage().sql();
        match req.path().as_str() {
            "/members" | "/observers" | "/lookup" => {
                let query = if req.path() != "/observers" {
                    "SELECT id FROM entries WHERE member=1"
                } else {
                    "SELECT DISTINCT id FROM entries"
                };
                let ids = sql
                    .exec(query, None)?
                    .to_array::<Id>()?
                    .into_iter()
                    .map(|r| r.id)
                    .collect::<Vec<_>>();
                if req.path() == "/lookup" {
                    Response::from_json(
                        &serde_json::json!({"members":ids,"epoch":self.db.get::<u64>("epoch")?.unwrap_or(1)}),
                    )
                } else {
                    Response::from_json(&ids)
                }
            }
            "/record" => {
                let e: Entry = req.json().await?;
                if e.add {
                    if e.member {
                        let members = sql
                            .exec("SELECT id FROM entries WHERE member=1", None)?
                            .to_array::<Id>()?;
                        if members.len() >= self.limit && !members.iter().any(|r| r.id == e.id) {
                            return Response::from_json(&false);
                        }
                    }
                    sql.exec(
                        "INSERT OR REPLACE INTO entries VALUES(?,?,?)",
                        vec![e.id.into(), (e.member as i32).into(), e.sid.into()],
                    )?;
                } else {
                    let removed = sql
                        .exec(
                            "DELETE FROM entries WHERE id=? AND member=? AND sid=? RETURNING id",
                            vec![e.id.into(), (e.member as i32).into(), e.sid.into()],
                        )?
                        .to_array::<Id>()?;
                    if e.member
                        && !removed.is_empty()
                        && sql
                            .exec("SELECT id FROM entries WHERE member=1 LIMIT 1", None)?
                            .to_array::<Id>()?
                            .is_empty()
                    {
                        self.db
                            .put("epoch", &(self.db.get::<u64>("epoch")?.unwrap_or(1) + 1))?;
                    }
                }
                Response::from_json(&self.db.get::<u64>("epoch")?.unwrap_or(1))
            }
            _ => Response::error("Unknown directory operation", 404),
        }
    }
}
