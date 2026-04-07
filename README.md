import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "spinout-v3";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Helper to call the Netlify Function proxy instead of Anthropic directly
async function callAgent(prompt) {
  const response = await fetch("/.netlify/functions/research", {
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

// localStorage helpers
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error("Storage error:", e);
  }
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

  useEffect(() => {
    setFirms(loadData());
    setLoaded(true);
  }, []);

  const persist = useCallback((data) => {
    saveData(data);
  }, []);

  const researchFirm = async (firmName) => {
    setResearching(true);
    setResearchError(null);
    setResearchLog(["Starting historical research…", `Firm: ${firmName}`]);

    try {
      setResearchLog((l) => [...l, "Searching press releases, news archives, SEC filings…"]);

      const data = await callAgent(buildResearchPrompt(firmName));

      setResearchLog((l) => [...l, "Parsing results…"]);

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
          next = prev.map((f) =>
            f.name.toLowerCase() === firmName.toLowerCase()
              ? { ...f, people: [...f.people, ...newPeople], lastResearched: new Date().toISOString() }
              : f
          );
        } else {
          next = [...prev, { name: firmName, people, lastResearched: new Date().toISOString(), id: uid() }];
        }
        persist(next);
        setActiveFirm(firmName);
        return next;
      });

      setResearchLog((l) => [...l, `Done — found ${people.length} departure${people.length !== 1 ? "s" : ""}`]);
    } catch (err) {
      setResearchError(err.message);
      setResearchLog((l) => [...l, `Error: ${err.message}`]);
    } finally {
      setResearching(false);
    }
  };

  const addFirm = () => {
    const name = firmInput.trim();
    if (!name) return;
    setFirmInput("");
    researchFirm(name);
  };

  const removeFirm = (firmName) => {
    setFirms((prev) => {
      const next = prev.filter((f) => f.name !== firmName);
      persist(next);
      return next;
    });
    if (activeFirm === firmName) setActiveFirm(null);
  };

  const removePerson = (firmName, personId) => {
    setFirms((prev) => {
      const next = prev.map((f) =>
        f.name === firmName ? { ...f, people: f.people.filter((p) => p._id !== personId) } : f
      );
      persist(next);
      return next;
    });
  };

  const deepDive = async (person, firmName) => {
    const key = `${person.name}|||${firmName}`;
    if (deepDiveData[key]) {
      setDeepDiving(deepDiving === key ? null : key);
      return;
    }
    setDeepDiving(key);

    try {
      const data = await callAgent(buildDeepDivePrompt(person.name, firmName));
      const raw = data.text || "";

      let parsed = {};
      try {
        const cleaned = raw.replace(/```json\n?|```/g, "").trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      } catch (e) {
        parsed = { error: "Could not parse deep dive results" };
      }

      setDeepDiveData((prev) => ({ ...prev, [key]: parsed }));
    } catch (err) {
      setDeepDiveData((prev) => ({ ...prev, [key]: { error: err.message } }));
    }
  };

  const activeFirmData = firms.find((f) => f.name === activeFirm);

  const getFilteredPeople = () => {
    if (!activeFirmData) return [];
    let people = [...activeFirmData.people];

    if (filterDest !== "All") {
      people = people.filter((p) => p.destination_type === filterDest);
    }
    if (searchQ) {
      const q = searchQ.toLowerCase();
      people = people.filter((p) =>
        [p.name, p.former_title, p.destination, p.new_fund_strategy].some((v) => v?.toLowerCase().includes(q))
      );
    }

    people.sort((a, b) => {
      const yA = parseInt(a.departure_year) || 0;
      const yB = parseInt(b.departure_year) || 0;
      if (sortBy === "year_desc") return yB - yA;
      if (sortBy === "year_asc") return yA - yB;
      if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
      return 0;
    });

    return people;
  };

  const destTypes = [
    ["All", "All"],
    ["spinout", "Spinouts"],
    ["joined_other_firm", "Joined Other Firm"],
    ["operating_role", "Operating Role"],
    ["retired", "Retired"],
    ["unknown", "Unknown"],
  ];

  const destColor = (type) => {
    switch (type) {
      case "spinout": return { bg: "#c8ff0018", text: "#c8ff00", border: "#c8ff0033" };
      case "joined_other_firm": return { bg: "#3b82f618", text: "#60a5fa", border: "#3b82f633" };
      case "operating_role": return { bg: "#a855f718", text: "#c084fc", border: "#a855f733" };
      case "retired": return { bg: "#71717a18", text: "#a1a1aa", border: "#71717a33" };
      default: return { bg: "#27272a", text: "#71717a", border: "#3f3f46" };
    }
  };

  if (!loaded) return null;

  const filteredPeople = activeFirmData ? getFilteredPeople() : [];
  const spinoutCount = activeFirmData?.people.filter((p) => p.destination_type === "spinout").length || 0;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Outfit:wght@300;400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes scanLine{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
        .rt{font-family:'Outfit',sans-serif;background:#08080a;color:#e4e4e7;min-height:100vh}
        .mono{font-family:'DM Mono',monospace}

        .hd{border-bottom:1px solid #1a1a1f;background:linear-gradient(180deg,#0e0e12,#08080a);position:sticky;top:0;z-index:10;padding:20px 24px 16px}
        .hd-top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px}
        .brand{display:flex;align-items:center;gap:14px}
        .logo{font-size:24px;color:#c8ff00;width:42px;height:42px;display:flex;align-items:center;justify-content:center;border:1px solid #c8ff0030;border-radius:10px;background:#c8ff0006;letter-spacing:-2px}
        .bt{font-size:15px;font-weight:500;letter-spacing:.14em;color:#fafafa}
        .bs{font-size:11px;color:#52525b;font-weight:300;margin-top:2px}

        .search-row{display:flex;gap:10px;flex-wrap:wrap}
        .inp{padding:10px 14px;font-size:14px;background:#111114;border:1px solid #1e1e24;border-radius:8px;color:#e4e4e7;outline:none;flex:1 1 280px}
        .inp:focus{border-color:#c8ff0044}
        .inp::placeholder{color:#3f3f46}
        .go-btn{padding:10px 22px;font-size:12px;font-weight:500;color:#08080a;background:#c8ff00;border:none;border-radius:8px;cursor:pointer;white-space:nowrap;letter-spacing:.03em}
        .go-btn:disabled{opacity:.4;cursor:default}

        .body{display:flex;min-height:calc(100vh - 120px)}
        .sidebar{width:240px;min-width:240px;border-right:1px solid #1a1a1f;padding:16px 0;overflow-y:auto;background:#0b0b0e}
        .sb-title{font-size:10px;color:#52525b;text-transform:uppercase;letter-spacing:.1em;padding:0 16px 8px;font-weight:500}
        .sb-item{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;cursor:pointer;transition:background .15s;font-size:13px;color:#a1a1aa;border-left:2px solid transparent}
        .sb-item:hover{background:#111114}
        .sb-item.active{background:#111114;color:#fafafa;border-left-color:#c8ff00}
        .sb-count{font-size:11px;color:#52525b;min-width:20px;text-align:right}
        .sb-x{background:none;border:none;color:#3f3f46;font-size:16px;cursor:pointer;padding:0 0 0 6px;opacity:0;transition:opacity .15s}
        .sb-item:hover .sb-x{opacity:1}
        .sb-x:hover{color:#ef4444}
        .sb-empty{padding:20px 16px;font-size:12px;color:#3f3f46;text-align:center}

        .main{flex:1;padding:24px;overflow-y:auto}
        .empty-main{display:flex;flex-direction:column;align-items:center;justify-content:center;height:60vh;text-align:center}
        .em-icon{font-size:48px;color:#1e1e24;margin-bottom:16px}
        .em-text{font-size:17px;color:#3f3f46;font-weight:500}
        .em-sub{font-size:13px;color:#27272a;margin-top:6px;max-width:360px;line-height:1.5}

        .firm-hdr{margin-bottom:20px}
        .firm-name{font-size:24px;font-weight:700;color:#fafafa;margin-bottom:4px}
        .firm-meta{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
        .fm-stat{font-size:12px;color:#52525b}
        .fm-stat b{color:#a1a1aa;font-weight:500}
        .rescan-btn{padding:6px 14px;font-size:11px;background:#111114;color:#c8ff00;border:1px solid #c8ff0030;border-radius:6px;cursor:pointer;margin-left:auto}
        .rescan-btn:hover{background:#1a1a1f}

        .toolbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
        .filter-inp{padding:7px 12px;font-size:12px;background:#111114;border:1px solid #1e1e24;border-radius:6px;color:#e4e4e7;outline:none;width:200px}
        .filter-inp:focus{border-color:#c8ff0033}
        .chips{display:flex;gap:5px;flex-wrap:wrap}
        .chip{padding:5px 11px;font-size:11px;background:#111114;color:#52525b;border:1px solid transparent;border-radius:16px;cursor:pointer;transition:all .15s}
        .chip:hover{color:#a1a1aa}
        .chip.on{color:#fafafa;background:#1a1a1f;border-color:#c8ff0044}
        .sort-sel{padding:6px 10px;font-size:11px;background:#111114;border:1px solid #1e1e24;border-radius:6px;color:#a1a1aa;outline:none;cursor:pointer;margin-left:auto}

        .timeline{position:relative;padding-left:28px}
        .timeline::before{content:'';position:absolute;left:10px;top:0;bottom:0;width:1px;background:#1e1e24}
        .t-year{position:relative;margin-bottom:4px}
        .t-year-label{position:absolute;left:-28px;width:22px;height:22px;background:#c8ff00;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;color:#08080a;font-weight:700;z-index:1}
        .t-year-text{font-size:13px;font-weight:600;color:#c8ff00;padding:2px 0 8px 12px;letter-spacing:.04em}

        .person{position:relative;margin-bottom:8px;animation:fadeIn .35s ease both}
        .person::before{content:'';position:absolute;left:-22px;top:16px;width:7px;height:7px;border-radius:50%;background:#27272a;border:1px solid #3f3f46;z-index:1}
        .p-card{background:#0e0e12;border:1px solid #1a1a1f;border-radius:10px;padding:14px 16px;margin-left:8px;cursor:pointer;transition:all .15s}
        .p-card:hover{border-color:#27272a;background:#111114}
        .p-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
        .p-name{font-size:15px;font-weight:600;color:#fafafa}
        .p-title{font-size:12px;color:#71717a;font-weight:300;margin-top:1px}
        .p-dest{margin-top:8px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dest-badge{display:inline-block;padding:3px 10px;font-size:10px;border-radius:14px;text-transform:capitalize;font-weight:500;letter-spacing:.02em}
        .p-dest-name{color:#e4e4e7;font-weight:500}
        .p-strategy{font-size:12px;color:#52525b;margin-top:6px;font-style:italic}
        .p-summary{font-size:11px;color:#3f3f46;margin-top:4px}
        .p-fund{font-size:11px;color:#71717a;margin-top:4px}

        .dd{border-top:1px solid #1a1a1f;margin-top:12px;padding-top:12px;animation:fadeIn .3s ease}
        .dd-loading{font-size:12px;color:#52525b;animation:pulse 1.2s infinite}
        .dd-section{margin-bottom:10px}
        .dd-label{font-size:9px;color:#3f3f46;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px;font-weight:500}
        .dd-val{font-size:12px;color:#a1a1aa;line-height:1.5}
        .dd-timeline{display:flex;flex-direction:column;gap:3px}
        .dd-tl-item{font-size:11px;color:#71717a;display:flex;gap:8px}
        .dd-tl-year{color:#52525b;min-width:36px}
        .dd-tl-role{color:#a1a1aa}
        .dd-tl-org{color:#71717a}
        .dd-deals{display:flex;flex-wrap:wrap;gap:4px}
        .dd-deal{font-size:10px;padding:3px 8px;background:#1a1a1f;border-radius:10px;color:#a1a1aa}
        .dd-err{font-size:12px;color:#ef4444}
        .p-remove{background:none;border:none;color:#3f3f46;font-size:14px;cursor:pointer;padding:2px 4px;opacity:0;transition:opacity .15s}
        .p-card:hover .p-remove{opacity:1}
        .p-remove:hover{color:#ef4444}

        .log-box{background:#0b0b0e;border:1px solid #1a1a1f;border-radius:10px;padding:16px;margin-bottom:20px;font-size:12px;overflow:hidden}
        .scan-bar{height:2px;background:#1a1a1f;border-radius:1px;overflow:hidden;margin-bottom:10px}
        .scan-bar-in{height:100%;width:40%;background:#c8ff00;border-radius:1px;animation:scanLine 1.5s ease-in-out infinite}
        .log-ln{color:#3f3f46;padding:2px 0}
        .log-d{color:#c8ff00;margin-right:8px}
        .err-box{background:#1c0f0f;border:1px solid #7f1d1d44;border-radius:8px;padding:10px 14px;color:#fca5a5;font-size:12px;margin-bottom:14px}

        @media(max-width:700px){
          .sidebar{display:none}
          .body{flex-direction:column}
        }
      `}</style>

      <div className="rt">
        <div className="hd">
          <div className="hd-top">
            <div className="brand">
              <div className="logo mono">◈</div>
              <div>
                <div className="bt mono">SPINOUT TRACKER</div>
                <div className="bs mono">Historical GP Movement & Talent Mapping</div>
              </div>
            </div>
          </div>
          <div className="search-row">
            <input
              className="inp mono"
              value={firmInput}
              onChange={(e) => setFirmInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !researching && addFirm()}
              placeholder="Enter a firm name to research its GP departures…"
            />
            <button className="go-btn mono" disabled={!firmInput.trim() || researching} onClick={addFirm}>
              {researching ? "Researching…" : "Research Firm"}
            </button>
          </div>
        </div>

        <div className="body">
          <div className="sidebar">
            <div className="sb-title mono">Researched Firms</div>
            {firms.length === 0 ? (
              <div className="sb-empty mono">No firms researched yet</div>
            ) : (
              firms.map((f) => (
                <div
                  key={f.id}
                  className={`sb-item${activeFirm === f.name ? " active" : ""}`}
                  onClick={() => setActiveFirm(f.name)}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                  <span className="sb-count mono">{f.people.length}</span>
                  <button className="sb-x" onClick={(e) => { e.stopPropagation(); removeFirm(f.name); }}>×</button>
                </div>
              ))
            )}
          </div>

          <div className="main">
            {researching && (
              <div className="log-box mono">
                <div className="scan-bar"><div className="scan-bar-in" /></div>
                {researchLog.map((msg, i) => (
                  <div key={i} className="log-ln"><span className="log-d">›</span> {msg}</div>
                ))}
              </div>
            )}
            {researchError && <div className="err-box mono">{researchError}</div>}

            {!activeFirm && !researching && (
              <div className="empty-main">
                <div className="em-icon">◈</div>
                <div className="em-text">Research a firm to map its talent movement</div>
                <div className="em-sub mono">Type a VC or PE firm name above. The tracker will search for historical GP departures, spinouts, and key people movements over time.</div>
              </div>
            )}

            {activeFirmData && (
              <div style={{ animation: "fadeIn .3s ease" }}>
                <div className="firm-hdr">
                  <div className="firm-name">{activeFirmData.name}</div>
                  <div className="firm-meta">
                    <span className="fm-stat mono"><b>{activeFirmData.people.length}</b> departures found</span>
                    <span className="fm-stat mono"><b>{spinoutCount}</b> spinouts</span>
                    <span className="fm-stat mono">Last researched: {new Date(activeFirmData.lastResearched).toLocaleDateString()}</span>
                    <button className="rescan-btn mono" disabled={researching} onClick={() => researchFirm(activeFirmData.name)}>
                      ⟳ Re-scan
                    </button>
                  </div>
                </div>

                <div className="toolbar">
                  <input className="filter-inp mono" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Filter people…" />
                  <div className="chips">
                    {destTypes.map(([val, label]) => (
                      <button key={val} className={`chip mono${filterDest === val ? " on" : ""}`} onClick={() => setFilterDest(val)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <select className="sort-sel mono" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                    <option value="year_desc">Newest first</option>
                    <option value="year_asc">Oldest first</option>
                    <option value="name">By name</option>
                  </select>
                </div>

                {filteredPeople.length === 0 ? (
                  <div className="empty-main" style={{ height: "30vh" }}>
                    <div className="em-text" style={{ fontSize: 14 }}>No results match your filters</div>
                  </div>
                ) : (
                  <div className="timeline">
                    {(() => {
                      let lastYear = null;
                      return filteredPeople.map((p, i) => {
                        const year = p.departure_year?.slice(0, 4) || "Unknown";
                        const showYear = sortBy !== "name" && year !== lastYear;
                        lastYear = year;
                        const dc = destColor(p.destination_type);
                        const ddKey = `${p.name}|||${activeFirm}`;
                        const isExpanded = deepDiving === ddKey;
                        const dd = deepDiveData[ddKey];

                        return (
                          <div key={p._id}>
                            {showYear && (
                              <div className="t-year">
                                <div className="t-year-label mono">{year === "Unknown" ? "?" : year.slice(2)}</div>
                                <div className="t-year-text mono">{year}</div>
                              </div>
                            )}
                            <div className="person" style={{ animationDelay: `${i * .03}s` }}>
                              <div className="p-card" onClick={() => deepDive(p, activeFirm)}>
                                <div className="p-top">
                                  <div style={{ flex: 1 }}>
                                    <div className="p-name">{p.name}</div>
                                    <div className="p-title mono">{p.former_title}</div>
                                  </div>
                                  <button className="p-remove" onClick={(e) => { e.stopPropagation(); removePerson(activeFirm, p._id); }}>×</button>
                                </div>
                                <div className="p-dest">
                                  <span className="dest-badge mono" style={{ background: dc.bg, color: dc.text, border: `1px solid ${dc.border}` }}>
                                    {p.destination_type?.replace("_", " ") || "unknown"}
                                  </span>
                                  <span className="p-dest-name">{p.destination || "Unknown"}</span>
                                </div>
                                {p.new_fund_strategy && <div className="p-strategy mono">{p.new_fund_strategy}</div>}
                                {p.fund_size && <div className="p-fund mono">Fund size: {p.fund_size}</div>}
                                {p.summary && <div className="p-summary mono">{p.summary}</div>}

                                {isExpanded && (
                                  <div className="dd">
                                    {!dd && <div className="dd-loading mono">Researching {p.name}…</div>}
                                    {dd?.error && <div className="dd-err mono">{dd.error}</div>}
                                    {dd && !dd.error && (
                                      <>
                                        {dd.current_role && (
                                          <div className="dd-section">
                                            <div className="dd-label mono">Current Role</div>
                                            <div className="dd-val">{dd.current_role}</div>
                                          </div>
                                        )}
                                        {dd.career_timeline?.length > 0 && (
                                          <div className="dd-section">
                                            <div className="dd-label mono">Career Timeline</div>
                                            <div className="dd-timeline">
                                              {dd.career_timeline.map((ct, j) => (
                                                <div key={j} className="dd-tl-item mono">
                                                  <span className="dd-tl-year">{ct.year}</span>
                                                  <span className="dd-tl-role">{ct.role}</span>
                                                  <span className="dd-tl-org">@ {ct.org}</span>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                        {dd.fund_details?.name && (
                                          <div className="dd-section">
                                            <div className="dd-label mono">Fund Details</div>
                                            <div className="dd-val">
                                              {dd.fund_details.name}{dd.fund_details.size ? ` · ${dd.fund_details.size}` : ""}
                                              {dd.fund_details.strategy ? ` · ${dd.fund_details.strategy}` : ""}
                                            </div>
                                            {dd.fund_details.notable_investments?.length > 0 && (
                                              <div className="dd-deals" style={{ marginTop: 4 }}>
                                                {dd.fund_details.notable_investments.map((inv, j) => (
                                                  <span key={j} className="dd-deal mono">{inv}</span>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                        {dd.notable_deals_at_former_firm?.length > 0 && (
                                          <div className="dd-section">
                                            <div className="dd-label mono">Notable Deals at {activeFirm}</div>
                                            <div className="dd-deals">
                                              {dd.notable_deals_at_former_firm.map((d, j) => (
                                                <span key={j} className="dd-deal mono">{d}</span>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                        {dd.linkedin_summary && (
                                          <div className="dd-section">
                                            <div className="dd-label mono">LinkedIn</div>
                                            <div className="dd-val" style={{ fontSize: 11 }}>{dd.linkedin_summary}</div>
                                          </div>
                                        )}
                                        {dd.additional_context && (
                                          <div className="dd-section">
                                            <div className="dd-label mono">Additional Context</div>
                                            <div className="dd-val" style={{ fontSize: 11 }}>{dd.additional_context}</div>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
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
