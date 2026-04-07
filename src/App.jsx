import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "spinout-v3";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function callAgent(prompt) {
  const response = await fetch("/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${response.status}`);
  }
  return response.json();
}

function buildResearchPrompt(firm) {
  return `You are a VC/PE industry research analyst. Search the web thoroughly and compile a COMPREHENSIVE HISTORICAL record of partners, GPs, managing directors, and principals who have LEFT "${firm}" over time — whether they spun out to start their own fund, joined another firm, retired, or moved to an operating role.

Search extensively using multiple queries such as:
- "${firm}" partner leaves
- "${firm}" GP departure
- "${firm}" spinout new fund
- former "${firm}" partner
- "${firm}" alumni fund
- "${firm}" executive changes

Look across all available years — this is a backward-looking historical research task, not just recent news. Go as far back as you can find information.

For each departure you find, return a JSON array with objects containing:
{
  "name": "Full Name",
  "former_title": "Their title/role at ${firm}",
  "departure_year": "YYYY or YYYY-MM if known, or 'Unknown'",
  "destination": "Where they went — new fund name, other firm, operating role, or 'Unknown'",
  "destination_type": "spinout | joined_other_firm | operating_role | retired | unknown",
  "new_fund_strategy": "If they started a fund, what's the strategy? Otherwise empty string",
  "fund_size": "If known, the fund size they raised. Otherwise empty string",
  "summary": "One sentence about what happened, sourced from news"
}

IMPORTANT: Return ONLY a valid JSON array. No markdown fences, no preamble, no explanation. If you find nothing, return [].
Be thorough — try to find as many departures as possible across all time periods.`;
}

function buildDeepDivePrompt(name, firm) {
  return `Search the web for detailed information about ${name}, who was formerly at ${firm}. Find:
1. Their full career trajectory (before, during, and after ${firm})
2. If they started a new fund: fund name, size, strategy, notable investments
3. Current role and status
4. Any notable deals or investments they led while at ${firm}
5. LinkedIn profile changes or recent activity

Return ONLY a JSON object (no markdown, no preamble):
{
  "current_role": "Their current title and organization",
  "career_timeline": [{"year": "YYYY", "role": "Title", "org": "Organization"}],
  "fund_details": {"name": "", "size": "", "strategy": "", "notable_investments": []},
  "notable_deals_at_former_firm": ["deal1", "deal2"],
  "linkedin_summary": "Any info found about their LinkedIn activity",
  "additional_context": "Any other relevant details"
}`;
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { console.error(e); }
}

export default function App() {
  const [firms, setFirms] = useState([]);
  const [firmInput, setFirmInput] = useState("");
  const [activeFirm, setActiveFirm] = useState(null);
  const [researching, setResearching] = useState(false);
  const [researchLog, setResearchLog] = useState([]);
  const [researchError, setResearchError] = useState(null);
  const [deepDiving, setDeepDiving] = useState(null);
  const [deepDiveData, setDeepDiveData] = useState({});
  const [sortBy, setSortBy] = useState("year_desc");
  const [filterDest, setFilterDest] = useState("All");
  const [searchQ, setSearchQ] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { setFirms(loadData()); setLoaded(true); }, []);

  const persist = useCallback((data) => { saveData(data); }, []);

  const researchFirm = async (firmName) => {
    setResearching(true);
    setResearchError(null);
    setResearchLog(["Starting research…", `Firm: ${firmName}`]);
    try {
      setResearchLog((l) => [...l, "Searching press releases, news, SEC filings…"]);
      const data = await callAgent(buildResearchPrompt(firmName));
      setResearchLog((l) => [...l, "Parsing…"]);
      const raw = data.text || "";
      let parsed = [];
      try {
        const cleaned = raw.replace(/```json\n?|```/g, "").trim();
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) parsed = JSON.parse(match[0]);
      } catch (pe) {
        console.error("Parse fail:", pe, raw);
        setResearchError("Research completed but couldn't parse results.");
      }
      const people = parsed.map((p) => ({ ...p, _id: uid() }));
      setFirms((prev) => {
        const existing = prev.find((f) => f.name.toLowerCase() === firmName.toLowerCase());
        let next;
        if (existing) {
          const existingNames = new Set(existing.people.map((p) => p.name.toLowerCase()));
          const newPeople = people.filter((p) => !existingNames.has(p.name.toLowerCase()));
          next = prev.map((f) => f.name.toLowerCase() === firmName.toLowerCase() ? { ...f, people: [...f.people, ...newPeople], lastResearched: new Date().toISOString() } : f);
        } else {
          next = [...prev, { name: firmName, people, lastResearched: new Date().toISOString(), id: uid() }];
        }
        persist(next);
        setActiveFirm(firmName);
        return next;
      });
      setResearchLog((l) => [...l, `Done — ${people.length} departure${people.length !== 1 ? "s" : ""} found`]);
    } catch (err) {
      setResearchError(err.message);
      setResearchLog((l) => [...l, `Error: ${err.message}`]);
    } finally { setResearching(false); }
  };

  const addFirm = () => { const name = firmInput.trim(); if (!name) return; setFirmInput(""); researchFirm(name); };
  const removeFirm = (firmName) => { setFirms((prev) => { const next = prev.filter((f) => f.name !== firmName); persist(next); return next; }); if (activeFirm === firmName) setActiveFirm(null); };
  const removePerson = (firmName, personId) => { setFirms((prev) => { const next = prev.map((f) => f.name === firmName ? { ...f, people: f.people.filter((p) => p._id !== personId) } : f); persist(next); return next; }); };

  const deepDive = async (person, firmName) => {
    const key = `${person.name}|||${firmName}`;
    if (deepDiveData[key]) { setDeepDiving(deepDiving === key ? null : key); return; }
    setDeepDiving(key);
    try {
      const data = await callAgent(buildDeepDivePrompt(person.name, firmName));
      const raw = data.text || "";
      let parsed = {};
      try { const cleaned = raw.replace(/```json\n?|```/g, "").trim(); const match = cleaned.match(/\{[\s\S]*\}/); if (match) parsed = JSON.parse(match[0]); } catch (e) { parsed = { error: "Could not parse results" }; }
      setDeepDiveData((prev) => ({ ...prev, [key]: parsed }));
    } catch (err) { setDeepDiveData((prev) => ({ ...prev, [key]: { error: err.message } })); }
  };

  const activeFirmData = firms.find((f) => f.name === activeFirm);
  const getFilteredPeople = () => {
    if (!activeFirmData) return [];
    let people = [...activeFirmData.people];
    if (filterDest !== "All") people = people.filter((p) => p.destination_type === filterDest);
    if (searchQ) { const q = searchQ.toLowerCase(); people = people.filter((p) => [p.name, p.former_title, p.destination, p.new_fund_strategy].some((v) => v?.toLowerCase().includes(q))); }
    people.sort((a, b) => { const yA = parseInt(a.departure_year) || 0; const yB = parseInt(b.departure_year) || 0; if (sortBy === "year_desc") return yB - yA; if (sortBy === "year_asc") return yA - yB; if (sortBy === "name") return (a.name || "").localeCompare(b.name || ""); return 0; });
    return people;
  };

  const destTypes = [["All", "All"], ["spinout", "Spinouts"], ["joined_other_firm", "Other Firm"], ["operating_role", "Operating"], ["retired", "Retired"], ["unknown", "Unknown"]];
  const destColor = (type) => {
    switch (type) {
      case "spinout": return "#1a1a1a";
      case "joined_other_firm": return "#1a1a1a";
      case "operating_role": return "#1a1a1a";
      case "retired": return "#1a1a1a";
      default: return "#1a1a1a";
    }
  };
  const destTextColor = (type) => {
    switch (type) {
      case "spinout": return "#000";
      case "joined_other_firm": return "#555";
      case "operating_role": return "#555";
      case "retired": return "#888";
      default: return "#888";
    }
  };

  if (!loaded) return null;
  const filteredPeople = activeFirmData ? getFilteredPeople() : [];
  const spinoutCount = activeFirmData?.people.filter((p) => p.destination_type === "spinout").length || 0;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@300;400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes slideIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        @keyframes progress{0%{width:0}50%{width:60%}100%{width:100%}}
        body{background:#fff;color:#111;font-family:'IBM Plex Sans',sans-serif;-webkit-font-smoothing:antialiased}
        .mono{font-family:'IBM Plex Mono',monospace}
      `}</style>

      <div style={{minHeight:"100vh",background:"#fff"}}>
        {/* Header */}
        <div style={{borderBottom:"1px solid #e5e5e5",position:"sticky",top:0,zIndex:10,background:"#fff",padding:"16px 24px 12px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
            <div>
              <h1 style={{fontSize:18,fontWeight:600,color:"#111",letterSpacing:"-0.02em",margin:0}}>Spinout Tracker</h1>
              <p style={{fontSize:12,color:"#999",marginTop:2,fontWeight:400}}>GP departures & talent movement</p>
            </div>
            {activeFirmData && (
              <div style={{display:"flex",gap:20}}>
                <div style={{textAlign:"center"}}><div className="mono" style={{fontSize:18,fontWeight:500,color:"#111"}}>{activeFirmData.people.length}</div><div style={{fontSize:10,color:"#999",textTransform:"uppercase",letterSpacing:"0.06em"}}>departures</div></div>
                <div style={{textAlign:"center"}}><div className="mono" style={{fontSize:18,fontWeight:500,color:"#111"}}>{spinoutCount}</div><div style={{fontSize:10,color:"#999",textTransform:"uppercase",letterSpacing:"0.06em"}}>spinouts</div></div>
              </div>
            )}
          </div>
          <div style={{display:"flex",gap:8}}>
            <input
              value={firmInput}
              onChange={(e) => setFirmInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !researching && addFirm()}
              placeholder="Enter firm name…"
              style={{flex:1,padding:"9px 12px",fontSize:13,background:"#fafafa",border:"1px solid #e5e5e5",borderRadius:6,color:"#111",outline:"none",fontFamily:"inherit"}}
            />
            <button
              disabled={!firmInput.trim() || researching}
              onClick={addFirm}
              style={{padding:"9px 18px",fontSize:12,fontWeight:500,color:"#fff",background:"#111",border:"none",borderRadius:6,cursor:"pointer",opacity:!firmInput.trim()||researching?.4:1,fontFamily:"inherit",whiteSpace:"nowrap"}}
            >
              {researching ? "Researching…" : "Research"}
            </button>
          </div>
        </div>

        <div style={{display:"flex",minHeight:"calc(100vh - 110px)"}}>
          {/* Sidebar */}
          <div style={{width:200,minWidth:200,borderRight:"1px solid #e5e5e5",padding:"16px 0",background:"#fafafa",overflowY:"auto"}}>
            <div style={{fontSize:10,color:"#999",textTransform:"uppercase",letterSpacing:"0.08em",padding:"0 16px 10px",fontWeight:500}}>Firms</div>
            {firms.length === 0 ? (
              <div style={{padding:"16px",fontSize:12,color:"#bbb",textAlign:"center"}}>No firms yet</div>
            ) : firms.map((f) => (
              <div
                key={f.id}
                onClick={() => setActiveFirm(f.name)}
                style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 16px",cursor:"pointer",fontSize:13,color:activeFirm===f.name?"#111":"#666",background:activeFirm===f.name?"#fff":"transparent",borderLeft:activeFirm===f.name?"2px solid #111":"2px solid transparent",transition:"all 0.15s",fontWeight:activeFirm===f.name?500:400}}
              >
                <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</span>
                <span className="mono" style={{fontSize:11,color:"#bbb",marginLeft:8}}>{f.people.length}</span>
                <button onClick={(e) => {e.stopPropagation();removeFirm(f.name);}} style={{background:"none",border:"none",color:"#ccc",fontSize:14,cursor:"pointer",padding:"0 0 0 6px",lineHeight:1}}>×</button>
              </div>
            ))}
          </div>

          {/* Main */}
          <div style={{flex:1,padding:24,overflowY:"auto"}}>
            {researching && (
              <div style={{background:"#fafafa",border:"1px solid #e5e5e5",borderRadius:8,padding:16,marginBottom:20}}>
                <div style={{height:2,background:"#eee",borderRadius:1,overflow:"hidden",marginBottom:12}}>
                  <div style={{height:"100%",background:"#111",borderRadius:1,animation:"progress 3s ease-in-out infinite"}} />
                </div>
                {researchLog.map((msg, i) => (
                  <div key={i} className="mono" style={{fontSize:12,color:"#999",padding:"2px 0"}}>{msg}</div>
                ))}
              </div>
            )}
            {researchError && <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,padding:"10px 14px",color:"#b91c1c",fontSize:12,marginBottom:16}}>{researchError}</div>}

            {!activeFirm && !researching && (
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"50vh",textAlign:"center"}}>
                <p style={{fontSize:15,color:"#bbb",fontWeight:400}}>Enter a firm name to research</p>
                <p style={{fontSize:12,color:"#ddd",marginTop:6}}>Historical GP departures, spinouts, and talent movement</p>
              </div>
            )}

            {activeFirmData && (
              <div style={{animation:"fadeIn .3s ease"}}>
                <div style={{marginBottom:20}}>
                  <h2 style={{fontSize:22,fontWeight:600,color:"#111",letterSpacing:"-0.02em"}}>{activeFirmData.name}</h2>
                  <div style={{display:"flex",gap:12,alignItems:"center",marginTop:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:12,color:"#999"}}>Last scanned {new Date(activeFirmData.lastResearched).toLocaleDateString()}</span>
                    <button onClick={() => researchFirm(activeFirmData.name)} disabled={researching} style={{fontSize:11,color:"#111",background:"none",border:"1px solid #e5e5e5",borderRadius:4,padding:"4px 10px",cursor:"pointer",fontFamily:"inherit"}}>Re-scan</button>
                  </div>
                </div>

                {/* Toolbar */}
                <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
                  <input
                    className="mono"
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    placeholder="Filter…"
                    style={{padding:"6px 10px",fontSize:12,background:"#fafafa",border:"1px solid #e5e5e5",borderRadius:4,color:"#111",outline:"none",width:160}}
                  />
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    {destTypes.map(([val, label]) => (
                      <button key={val} onClick={() => setFilterDest(val)} style={{padding:"4px 10px",fontSize:11,background:filterDest===val?"#111":"transparent",color:filterDest===val?"#fff":"#999",border:"1px solid",borderColor:filterDest===val?"#111":"#e5e5e5",borderRadius:4,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <select className="mono" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{padding:"5px 8px",fontSize:11,background:"#fafafa",border:"1px solid #e5e5e5",borderRadius:4,color:"#666",outline:"none",cursor:"pointer",marginLeft:"auto"}}>
                    <option value="year_desc">Newest first</option>
                    <option value="year_asc">Oldest first</option>
                    <option value="name">By name</option>
                  </select>
                </div>

                {filteredPeople.length === 0 ? (
                  <div style={{textAlign:"center",padding:"40px 20px",color:"#ccc",fontSize:13}}>No results</div>
                ) : (
                  <div>
                    {(() => {
                      let lastYear = null;
                      return filteredPeople.map((p, i) => {
                        const year = p.departure_year?.slice(0, 4) || "Unknown";
                        const showYear = sortBy !== "name" && year !== lastYear;
                        lastYear = year;
                        const ddKey = `${p.name}|||${activeFirm}`;
                        const isExpanded = deepDiving === ddKey;
                        const dd = deepDiveData[ddKey];

                        return (
                          <div key={p._id} style={{animation:"slideIn .25s ease both",animationDelay:`${i*.02}s`}}>
                            {showYear && (
                              <div className="mono" style={{fontSize:11,fontWeight:500,color:"#999",padding:"16px 0 6px",borderBottom:"1px solid #f0f0f0",marginBottom:8,letterSpacing:"0.04em"}}>{year}</div>
                            )}
                            <div
                              onClick={() => deepDive(p, activeFirm)}
                              style={{padding:"12px 0",borderBottom:"1px solid #f5f5f5",cursor:"pointer",transition:"background 0.1s"}}
                              onMouseEnter={(e) => e.currentTarget.style.background="#fafafa"}
                              onMouseLeave={(e) => e.currentTarget.style.background="transparent"}
                            >
                              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                                <div style={{flex:1}}>
                                  <div style={{fontSize:14,fontWeight:500,color:"#111"}}>{p.name}</div>
                                  <div className="mono" style={{fontSize:12,color:"#888",fontWeight:300,marginTop:1}}>{p.former_title}</div>
                                </div>
                                <button onClick={(e) => {e.stopPropagation();removePerson(activeFirm,p._id);}} style={{background:"none",border:"none",color:"#ddd",fontSize:14,cursor:"pointer",padding:"2px 4px"}}>×</button>
                              </div>
                              <div style={{marginTop:6,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                                <span className="mono" style={{fontSize:10,padding:"2px 8px",background:p.destination_type==="spinout"?"#111":"#f5f5f5",color:p.destination_type==="spinout"?"#fff":"#888",borderRadius:3,textTransform:"capitalize",fontWeight:400}}>
                                  {p.destination_type?.replace("_", " ") || "unknown"}
                                </span>
                                <span style={{fontSize:13,color:"#444",fontWeight:400}}>{p.destination || "Unknown"}</span>
                              </div>
                              {p.new_fund_strategy && <div style={{fontSize:12,color:"#999",marginTop:4}}>{p.new_fund_strategy}</div>}
                              {p.fund_size && <div className="mono" style={{fontSize:11,color:"#aaa",marginTop:2}}>Fund: {p.fund_size}</div>}
                              {p.summary && <div className="mono" style={{fontSize:11,color:"#bbb",marginTop:2}}>{p.summary}</div>}

                              {isExpanded && (
                                <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #f0f0f0",animation:"fadeIn .2s ease"}}>
                                  {!dd && <div className="mono" style={{fontSize:12,color:"#bbb"}}>Loading…</div>}
                                  {dd?.error && <div className="mono" style={{fontSize:12,color:"#b91c1c"}}>{dd.error}</div>}
                                  {dd && !dd.error && (
                                    <div style={{display:"grid",gap:10}}>
                                      {dd.current_role && (
                                        <div>
                                          <div className="mono" style={{fontSize:9,color:"#bbb",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:2}}>Current</div>
                                          <div style={{fontSize:13,color:"#444"}}>{dd.current_role}</div>
                                        </div>
                                      )}
                                      {dd.career_timeline?.length > 0 && (
                                        <div>
                                          <div className="mono" style={{fontSize:9,color:"#bbb",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>Timeline</div>
                                          {dd.career_timeline.map((ct, j) => (
                                            <div key={j} className="mono" style={{fontSize:11,color:"#888",display:"flex",gap:8,padding:"1px 0"}}>
                                              <span style={{color:"#bbb",minWidth:32}}>{ct.year}</span>
                                              <span style={{color:"#666"}}>{ct.role}</span>
                                              <span style={{color:"#aaa"}}>@ {ct.org}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                      {dd.fund_details?.name && (
                                        <div>
                                          <div className="mono" style={{fontSize:9,color:"#bbb",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:2}}>Fund</div>
                                          <div style={{fontSize:12,color:"#444"}}>{dd.fund_details.name}{dd.fund_details.size ? ` · ${dd.fund_details.size}` : ""}{dd.fund_details.strategy ? ` · ${dd.fund_details.strategy}` : ""}</div>
                                          {dd.fund_details.notable_investments?.length > 0 && (
                                            <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:4}}>
                                              {dd.fund_details.notable_investments.map((inv, j) => (
                                                <span key={j} className="mono" style={{fontSize:10,padding:"2px 6px",background:"#f5f5f5",borderRadius:3,color:"#888"}}>{inv}</span>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                      {dd.notable_deals_at_former_firm?.length > 0 && (
                                        <div>
                                          <div className="mono" style={{fontSize:9,color:"#bbb",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>Deals at {activeFirm}</div>
                                          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                                            {dd.notable_deals_at_former_firm.map((d, j) => (
                                              <span key={j} className="mono" style={{fontSize:10,padding:"2px 6px",background:"#f5f5f5",borderRadius:3,color:"#888"}}>{d}</span>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                      {dd.linkedin_summary && (
                                        <div>
                                          <div className="mono" style={{fontSize:9,color:"#bbb",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:2}}>LinkedIn</div>
                                          <div style={{fontSize:11,color:"#888"}}>{dd.linkedin_summary}</div>
                                        </div>
                                      )}
                                      {dd.additional_context && (
                                        <div>
                                          <div className="mono" style={{fontSize:9,color:"#bbb",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:2}}>Context</div>
                                          <div style={{fontSize:11,color:"#888"}}>{dd.additional_context}</div>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
