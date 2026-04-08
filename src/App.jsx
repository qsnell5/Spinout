import { useState, useEffect, useCallback, useRef } from "react";
import * as d3 from "d3";

const STORAGE_KEY = "spinout-v3";
const PASS_DELAY_MS = 65000;

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

function buildPass1Prompt(firm) {
  return `You are a VC/PE industry research analyst. Search the web thoroughly and compile a COMPREHENSIVE HISTORICAL record of partners, GPs, managing directors, principals, and senior investors who have LEFT "${firm}" over time — whether they spun out to start their own fund, joined another firm, retired, or moved to an operating role.

Search using these queries:
- "${firm}" partner leaves departure
- "${firm}" managing director left
- "${firm}" principal departure
- former "${firm}" partner
- "${firm}" executive changes leadership

Look across ALL available years — go as far back as you can find. This is a historical research task.

For each departure, return a JSON array:
[{
  "name": "Full Name",
  "former_title": "Title at ${firm}",
  "departure_year": "YYYY or YYYY-MM or Unknown",
  "destination": "Where they went or Unknown",
  "destination_type": "spinout | joined_other_firm | operating_role | retired | unknown",
  "new_fund_strategy": "Fund strategy if applicable, else empty string",
  "fund_size": "Fund size if known, else empty string",
  "current_role": "Current title and org if known, else empty string",
  "notable_deals": "Key deals at ${firm} if known, else empty string",
  "source": "Publication or source name"
}]

Return ONLY the JSON array. No markdown, no explanation. If nothing found, return [].`;
}

function buildPass2Prompt(firm, existingNames) {
  const nameList = existingNames.length > 0 ? `\n\nYou have ALREADY found these people — do NOT include them again:\n${existingNames.join(", ")}` : "";
  return `You are a VC/PE industry research analyst doing a DEEP SEARCH for spinouts from "${firm}". Search specifically for anyone who left "${firm}" to START THEIR OWN FUND or investment firm.

Search using these queries:
- "${firm}" spinout new fund launch
- "${firm}" alumni venture fund
- former "${firm}" investor raises fund
- "${firm}" GP launches debut fund
- "${firm}" partner new firm
- SEC Form D "${firm}" former

Focus specifically on fund launches and spinouts. Go back as far as possible.${nameList}

For each NEW person found, return the same JSON format:
[{
  "name": "Full Name",
  "former_title": "Title at ${firm}",
  "departure_year": "YYYY or YYYY-MM or Unknown",
  "destination": "New fund/firm name or Unknown",
  "destination_type": "spinout | joined_other_firm | operating_role | retired | unknown",
  "new_fund_strategy": "Fund strategy if applicable, else empty string",
  "fund_size": "Fund size if known, else empty string",
  "current_role": "Current title and org if known, else empty string",
  "notable_deals": "Key deals at ${firm} if known, else empty string",
  "source": "Publication or source name"
}]

Return ONLY the JSON array. No markdown, no explanation. If no NEW people found, return [].`;
}

function buildPass3Prompt(firm, existingNames) {
  const nameList = existingNames.length > 0 ? `\n\nYou have ALREADY found these people — do NOT include them again:\n${existingNames.join(", ")}` : "";
  return `You are a VC/PE industry research analyst. You have already done two searches on "${firm}" departures but may have missed people. Do a FINAL SWEEP using DIFFERENT search approaches:

Search using these queries:
- "${firm}" team changes
- "${firm}" investor moves to
- "${firm}" partner joins (to find where they went, implying they left)
- PitchBook "${firm}" personnel
- LinkedIn "${firm}" former partner
- "${firm}" reorganization
- "${firm}" fund restructuring departures

Also try searching for the firm's sub-entities, regional offices, or affiliated funds if applicable.${nameList}

For each NEW person found, return the same JSON format:
[{
  "name": "Full Name",
  "former_title": "Title at ${firm}",
  "departure_year": "YYYY or YYYY-MM or Unknown",
  "destination": "Where they went or Unknown",
  "destination_type": "spinout | joined_other_firm | operating_role | retired | unknown",
  "new_fund_strategy": "Fund strategy if applicable, else empty string",
  "fund_size": "Fund size if known, else empty string",
  "current_role": "Current title and org if known, else empty string",
  "notable_deals": "Key deals at ${firm} if known, else empty string",
  "source": "Publication or source name"
}]

Return ONLY the JSON array. No markdown, no explanation. If no NEW people found, return [].`;
}

function parseResults(raw) {
  try {
    const cleaned = raw.replace(/```json\n?|```/g, "").trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch (e) { console.error("Parse fail:", e); }
  return [];
}

function deduplicatePeople(existing, newPeople) {
  const existingNames = new Set(existing.map((p) => p.name.toLowerCase().trim()));
  return newPeople.filter((p) => !existingNames.has(p.name.toLowerCase().trim()));
}

function loadData() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { console.error(e); }
}

/* ─── Network Map Component ─── */
function NetworkMap({ firms }) {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  const [yearRange, setYearRange] = useState([1990, 2026]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: 500 });

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (el) setDimensions({ w: el.clientWidth, h: Math.max(500, el.clientHeight - 80) });
    const handleResize = () => {
      if (el) setDimensions({ w: el.clientWidth, h: Math.max(500, el.clientHeight - 80) });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Build graph data
  const graphData = (() => {
    const nodeMap = {};
    const links = [];
    const allYears = [];

    firms.forEach((firm) => {
      if (!nodeMap[firm.name]) nodeMap[firm.name] = { id: firm.name, type: "source", count: 0, people: [] };

      firm.people.forEach((p) => {
        const yr = parseInt(p.departure_year) || 0;
        if (yr > 0) allYears.push(yr);
        if (yr > 0 && (yr < yearRange[0] || yr > yearRange[1])) return;

        nodeMap[firm.name].count++;
        nodeMap[firm.name].people.push(p);

        const dest = p.destination && p.destination !== "Unknown" ? p.destination : null;
        if (dest) {
          if (!nodeMap[dest]) nodeMap[dest] = { id: dest, type: p.destination_type === "spinout" ? "spinout" : "destination", count: 0, people: [] };
          nodeMap[dest].count++;
          nodeMap[dest].people.push(p);
          links.push({
            source: firm.name,
            target: dest,
            person: p.name,
            year: yr || "Unknown",
            type: p.destination_type,
            title: p.former_title,
          });
        }
      });
    });

    const minYear = allYears.length > 0 ? Math.min(...allYears) : 1990;
    const maxYear = allYears.length > 0 ? Math.max(...allYears) : 2026;

    return {
      nodes: Object.values(nodeMap).filter((n) => n.count > 0),
      links,
      minYear,
      maxYear,
    };
  })();

  useEffect(() => {
    if (!svgRef.current || graphData.nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const { w, h } = dimensions;
    const g = svg.append("g");

    // Zoom
    const zoom = d3.zoom().scaleExtent([0.2, 4]).on("zoom", (e) => g.attr("transform", e.transform));
    svg.call(zoom);

    // Arrow markers
    g.append("defs").selectAll("marker")
      .data(["spinout", "other"])
      .join("marker")
      .attr("id", (d) => `arrow-${d}`)
      .attr("viewBox", "0 0 10 6")
      .attr("refX", 20)
      .attr("refY", 3)
      .attr("markerWidth", 8)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,0L10,3L0,6")
      .attr("fill", (d) => d === "spinout" ? "#111" : "#ccc");

    // Size scale
    const maxCount = Math.max(...graphData.nodes.map((n) => n.count), 1);
    const sizeScale = d3.scaleSqrt().domain([1, maxCount]).range([8, 40]);

    // Simulation
    const simulation = d3.forceSimulation(graphData.nodes)
      .force("link", d3.forceLink(graphData.links).id((d) => d.id).distance(120))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collision", d3.forceCollide().radius((d) => sizeScale(d.count) + 10));

    // Links
    const link = g.append("g").selectAll("line")
      .data(graphData.links)
      .join("line")
      .attr("stroke", (d) => d.type === "spinout" ? "#111" : "#ddd")
      .attr("stroke-width", (d) => d.type === "spinout" ? 1.5 : 1)
      .attr("stroke-opacity", 0.6)
      .attr("marker-end", (d) => `url(#arrow-${d.type === "spinout" ? "spinout" : "other"})`);

    // Node groups
    const node = g.append("g").selectAll("g")
      .data(graphData.nodes)
      .join("g")
      .attr("cursor", "pointer")
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    // Node circles
    node.append("circle")
      .attr("r", (d) => sizeScale(d.count))
      .attr("fill", (d) => d.type === "source" ? "#111" : d.type === "spinout" ? "#fff" : "#f5f5f5")
      .attr("stroke", (d) => d.type === "source" ? "#111" : d.type === "spinout" ? "#111" : "#ddd")
      .attr("stroke-width", (d) => d.type === "spinout" ? 2 : 1);

    // Node labels
    node.append("text")
      .text((d) => d.id.length > 20 ? d.id.slice(0, 18) + "…" : d.id)
      .attr("dy", (d) => sizeScale(d.count) + 14)
      .attr("text-anchor", "middle")
      .attr("font-family", "'IBM Plex Sans', sans-serif")
      .attr("font-size", 10)
      .attr("font-weight", (d) => d.type === "source" ? 600 : 400)
      .attr("fill", "#555")
      .attr("pointer-events", "none");

    // Count labels inside nodes
    node.append("text")
      .text((d) => d.count)
      .attr("text-anchor", "middle")
      .attr("dy", 4)
      .attr("font-family", "'IBM Plex Mono', monospace")
      .attr("font-size", (d) => Math.max(8, sizeScale(d.count) * 0.5))
      .attr("font-weight", 500)
      .attr("fill", (d) => d.type === "source" ? "#fff" : "#111")
      .attr("pointer-events", "none");

    // Hover
    node.on("mouseenter", function (e, d) {
      d3.select(this).select("circle").attr("stroke-width", 3).attr("stroke", "#111");
      link.attr("stroke-opacity", (l) => (l.source.id === d.id || l.target.id === d.id) ? 1 : 0.1);
    }).on("mouseleave", function (e, d) {
      d3.select(this).select("circle")
        .attr("stroke-width", d.type === "spinout" ? 2 : 1)
        .attr("stroke", d.type === "source" ? "#111" : d.type === "spinout" ? "#111" : "#ddd");
      link.attr("stroke-opacity", 0.6);
    }).on("click", (e, d) => {
      setSelectedNode(selectedNode?.id === d.id ? null : d);
    });

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    return () => simulation.stop();
  }, [graphData, dimensions]);

  if (firms.length === 0 || firms.every((f) => f.people.length === 0)) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "50vh", color: "#bbb", fontSize: 13 }}>
        Research some firms first to see the network map
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Timeline slider */}
      <div style={{ padding: "12px 0", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 11, color: "#999" }}>Timeline</span>
        <span className="mono" style={{ fontSize: 12, color: "#111", minWidth: 36 }}>{yearRange[0]}</span>
        <input
          type="range"
          min={graphData.minYear || 1990}
          max={graphData.maxYear || 2026}
          value={yearRange[0]}
          onChange={(e) => setYearRange([+e.target.value, yearRange[1]])}
          style={{ flex: 1, maxWidth: 200, accentColor: "#111" }}
        />
        <input
          type="range"
          min={graphData.minYear || 1990}
          max={graphData.maxYear || 2026}
          value={yearRange[1]}
          onChange={(e) => setYearRange([yearRange[0], +e.target.value])}
          style={{ flex: 1, maxWidth: 200, accentColor: "#111" }}
        />
        <span className="mono" style={{ fontSize: 12, color: "#111", minWidth: 36 }}>{yearRange[1]}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: 11, color: "#999" }}>
          <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#111", verticalAlign: "middle", marginRight: 4 }} />Source firm</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", border: "2px solid #111", background: "#fff", verticalAlign: "middle", marginRight: 4 }} />Spinout</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#f5f5f5", border: "1px solid #ddd", verticalAlign: "middle", marginRight: 4 }} />Other</span>
        </div>
      </div>

      <div style={{ flex: 1, position: "relative", border: "1px solid #e5e5e5", borderRadius: 8, overflow: "hidden", background: "#fafafa" }}>
        <svg ref={svgRef} width={dimensions.w} height={dimensions.h} style={{ display: "block" }} />

        {/* Selected node detail panel */}
        {selectedNode && (
          <div style={{
            position: "absolute", top: 12, right: 12, width: 280, maxHeight: dimensions.h - 24,
            background: "#fff", border: "1px solid #e5e5e5", borderRadius: 8, padding: 16,
            overflowY: "auto", boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#111" }}>{selectedNode.id}</div>
                <div className="mono" style={{ fontSize: 11, color: "#999", marginTop: 2 }}>
                  {selectedNode.count} people · {selectedNode.type}
                </div>
              </div>
              <button onClick={() => setSelectedNode(null)} style={{ background: "none", border: "none", color: "#ccc", fontSize: 16, cursor: "pointer" }}>×</button>
            </div>
            {selectedNode.people.map((p, i) => (
              <div key={i} style={{ padding: "8px 0", borderTop: i > 0 ? "1px solid #f0f0f0" : "none" }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#111" }}>{p.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "#888" }}>{p.former_title}</div>
                <div style={{ fontSize: 11, color: "#aaa", marginTop: 2 }}>
                  {p.departure_year !== "Unknown" ? p.departure_year : ""} {p.destination && p.destination !== "Unknown" ? `→ ${p.destination}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Main App ─── */
export default function App() {
  const [firms, setFirms] = useState([]);
  const [firmInput, setFirmInput] = useState("");
  const [activeFirm, setActiveFirm] = useState(null);
  const [researching, setResearching] = useState(false);
  const [researchLog, setResearchLog] = useState([]);
  const [researchError, setResearchError] = useState(null);
  const [sortBy, setSortBy] = useState("year_desc");
  const [filterDest, setFilterDest] = useState("All");
  const [searchQ, setSearchQ] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("list"); // "list" | "map"
  const cancelRef = useRef(false);

  useEffect(() => { setFirms(loadData()); setLoaded(true); }, []);
  const persist = useCallback((data) => { saveData(data); }, []);
  const addLog = (msg) => setResearchLog((l) => [...l, msg]);

  const sleep = (ms) => new Promise((resolve) => {
    const interval = 1000;
    let elapsed = 0;
    const tick = () => {
      if (cancelRef.current) { resolve(); return; }
      elapsed += interval;
      const remaining = Math.ceil((ms - elapsed) / 1000);
      if (remaining > 0) {
        setResearchLog((l) => {
          const updated = [...l];
          updated[updated.length - 1] = `Waiting ${remaining}s before next pass (rate limit buffer)…`;
          return updated;
        });
        setTimeout(tick, interval);
      } else { resolve(); }
    };
    addLog(`Waiting ${Math.ceil(ms / 1000)}s before next pass (rate limit buffer)…`);
    setTimeout(tick, interval);
  });

  const researchFirm = async (firmName) => {
    cancelRef.current = false;
    setResearching(true);
    setResearchError(null);
    setResearchLog([]);
    let allPeople = [];

    try {
      addLog("Pass 1/3 — Searching for senior departures…");
      const r1 = await callAgent(buildPass1Prompt(firmName));
      const p1 = parseResults(r1.text || "").map((p) => ({ ...p, _id: uid() }));
      allPeople = [...p1];
      addLog(`Pass 1 complete — found ${p1.length} people`);
      updateFirmData(firmName, allPeople);
      if (cancelRef.current) throw new Error("Cancelled");

      await sleep(PASS_DELAY_MS);
      if (cancelRef.current) throw new Error("Cancelled");

      const names1 = allPeople.map((p) => p.name);
      addLog("Pass 2/3 — Deep search for spinouts & fund launches…");
      const r2 = await callAgent(buildPass2Prompt(firmName, names1));
      const p2raw = parseResults(r2.text || "");
      const p2 = deduplicatePeople(allPeople, p2raw).map((p) => ({ ...p, _id: uid() }));
      allPeople = [...allPeople, ...p2];
      addLog(`Pass 2 complete — found ${p2.length} new people`);
      updateFirmData(firmName, allPeople);
      if (cancelRef.current) throw new Error("Cancelled");

      await sleep(PASS_DELAY_MS);
      if (cancelRef.current) throw new Error("Cancelled");

      const names2 = allPeople.map((p) => p.name);
      addLog("Pass 3/3 — Final sweep with alternate search patterns…");
      const r3 = await callAgent(buildPass3Prompt(firmName, names2));
      const p3raw = parseResults(r3.text || "");
      const p3 = deduplicatePeople(allPeople, p3raw).map((p) => ({ ...p, _id: uid() }));
      allPeople = [...allPeople, ...p3];
      addLog(`Pass 3 complete — found ${p3.length} new people`);
      updateFirmData(firmName, allPeople);
      addLog(`Research complete — ${allPeople.length} total departures found`);
    } catch (err) {
      if (err.message !== "Cancelled") { setResearchError(err.message); addLog(`Error: ${err.message}`); }
    } finally { setResearching(false); }
  };

  const updateFirmData = (firmName, people) => {
    setFirms((prev) => {
      const existing = prev.find((f) => f.name.toLowerCase() === firmName.toLowerCase());
      let next;
      if (existing) {
        next = prev.map((f) => f.name.toLowerCase() === firmName.toLowerCase() ? { ...f, people, lastResearched: new Date().toISOString() } : f);
      } else {
        next = [...prev, { name: firmName, people, lastResearched: new Date().toISOString(), id: uid() }];
      }
      persist(next);
      setActiveFirm(firmName);
      return next;
    });
  };

  const addFirm = () => { const name = firmInput.trim(); if (!name) return; setFirmInput(""); researchFirm(name); };
  const removeFirm = (firmName) => { setFirms((prev) => { const next = prev.filter((f) => f.name !== firmName); persist(next); return next; }); if (activeFirm === firmName) setActiveFirm(null); };
  const removePerson = (firmName, personId) => { setFirms((prev) => { const next = prev.map((f) => f.name === firmName ? { ...f, people: f.people.filter((p) => p._id !== personId) } : f); persist(next); return next; }); };
  const cancelResearch = () => { cancelRef.current = true; };

  const activeFirmData = firms.find((f) => f.name === activeFirm);
  const getFilteredPeople = () => {
    if (!activeFirmData) return [];
    let people = [...activeFirmData.people];
    if (filterDest !== "All") people = people.filter((p) => p.destination_type === filterDest);
    if (searchQ) { const q = searchQ.toLowerCase(); people = people.filter((p) => [p.name, p.former_title, p.destination, p.new_fund_strategy, p.current_role, p.notable_deals].some((v) => v?.toLowerCase().includes(q))); }
    people.sort((a, b) => { const yA = parseInt(a.departure_year) || 0; const yB = parseInt(b.departure_year) || 0; if (sortBy === "year_desc") return yB - yA; if (sortBy === "year_asc") return yA - yB; if (sortBy === "name") return (a.name || "").localeCompare(b.name || ""); return 0; });
    return people;
  };

  const destTypes = [["All", "All"], ["spinout", "Spinouts"], ["joined_other_firm", "Other Firm"], ["operating_role", "Operating"], ["retired", "Retired"], ["unknown", "Unknown"]];

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
        .tab-btn{padding:6px 14px;font-size:12px;font-weight:500;border:1px solid #e5e5e5;border-radius:4px;cursor:pointer;font-family:inherit;transition:all 0.15s;background:transparent;color:#999}
        .tab-btn.active{background:#111;color:#fff;border-color:#111}
      `}</style>

      <div style={{ minHeight: "100vh", background: "#fff" }}>
        {/* Header */}
        <div style={{ borderBottom: "1px solid #e5e5e5", position: "sticky", top: 0, zIndex: 10, background: "#fff", padding: "16px 24px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div>
                <h1 style={{ fontSize: 18, fontWeight: 600, color: "#111", letterSpacing: "-0.02em", margin: 0 }}>Spinout Tracker</h1>
                <p style={{ fontSize: 12, color: "#999", marginTop: 2, fontWeight: 400 }}>GP departures & talent movement</p>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button className={`tab-btn${tab === "list" ? " active" : ""}`} onClick={() => setTab("list")}>List</button>
                <button className={`tab-btn${tab === "map" ? " active" : ""}`} onClick={() => setTab("map")}>Network Map</button>
              </div>
            </div>
            {activeFirmData && tab === "list" && (
              <div style={{ display: "flex", gap: 20 }}>
                <div style={{ textAlign: "center" }}><div className="mono" style={{ fontSize: 18, fontWeight: 500, color: "#111" }}>{activeFirmData.people.length}</div><div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: "0.06em" }}>departures</div></div>
                <div style={{ textAlign: "center" }}><div className="mono" style={{ fontSize: 18, fontWeight: 500, color: "#111" }}>{spinoutCount}</div><div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: "0.06em" }}>spinouts</div></div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={firmInput} onChange={(e) => setFirmInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !researching && addFirm()} placeholder="Enter firm name…" style={{ flex: 1, padding: "9px 12px", fontSize: 13, background: "#fafafa", border: "1px solid #e5e5e5", borderRadius: 6, color: "#111", outline: "none", fontFamily: "inherit" }} />
            {researching ? (
              <button onClick={cancelResearch} style={{ padding: "9px 18px", fontSize: 12, fontWeight: 500, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>Cancel</button>
            ) : (
              <button disabled={!firmInput.trim()} onClick={addFirm} style={{ padding: "9px 18px", fontSize: 12, fontWeight: 500, color: "#fff", background: "#111", border: "none", borderRadius: 6, cursor: "pointer", opacity: !firmInput.trim() ? .4 : 1, fontFamily: "inherit", whiteSpace: "nowrap" }}>Research</button>
            )}
          </div>
        </div>

        <div style={{ display: "flex", minHeight: "calc(100vh - 110px)" }}>
          {/* Sidebar */}
          <div style={{ width: 200, minWidth: 200, borderRight: "1px solid #e5e5e5", padding: "16px 0", background: "#fafafa", overflowY: "auto" }}>
            <div style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: "0.08em", padding: "0 16px 10px", fontWeight: 500 }}>Firms</div>
            {firms.length === 0 ? (
              <div style={{ padding: "16px", fontSize: 12, color: "#bbb", textAlign: "center" }}>No firms yet</div>
            ) : firms.map((f) => (
              <div key={f.id} onClick={() => { setActiveFirm(f.name); if (tab === "map") setTab("list"); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px", cursor: "pointer", fontSize: 13, color: activeFirm === f.name ? "#111" : "#666", background: activeFirm === f.name ? "#fff" : "transparent", borderLeft: activeFirm === f.name ? "2px solid #111" : "2px solid transparent", transition: "all 0.15s", fontWeight: activeFirm === f.name ? 500 : 400 }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                <span className="mono" style={{ fontSize: 11, color: "#bbb", marginLeft: 8 }}>{f.people.length}</span>
                <button onClick={(e) => { e.stopPropagation(); removeFirm(f.name); }} style={{ background: "none", border: "none", color: "#ccc", fontSize: 14, cursor: "pointer", padding: "0 0 0 6px", lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>

          {/* Main */}
          <div style={{ flex: 1, padding: 24, overflowY: "auto" }}>
            {researching && (
              <div style={{ background: "#fafafa", border: "1px solid #e5e5e5", borderRadius: 8, padding: 16, marginBottom: 20 }}>
                <div style={{ height: 2, background: "#eee", borderRadius: 1, overflow: "hidden", marginBottom: 12 }}>
                  <div style={{ height: "100%", background: "#111", borderRadius: 1, animation: "progress 3s ease-in-out infinite" }} />
                </div>
                {researchLog.map((msg, i) => (
                  <div key={i} className="mono" style={{ fontSize: 12, color: "#999", padding: "2px 0" }}>{msg}</div>
                ))}
              </div>
            )}
            {researchError && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", color: "#b91c1c", fontSize: 12, marginBottom: 16 }}>{researchError}</div>}

            {/* MAP TAB */}
            {tab === "map" && (
              <div style={{ animation: "fadeIn .3s ease", height: "calc(100vh - 200px)" }}>
                <NetworkMap firms={firms} />
              </div>
            )}

            {/* LIST TAB */}
            {tab === "list" && (
              <>
                {!activeFirm && !researching && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "50vh", textAlign: "center" }}>
                    <p style={{ fontSize: 15, color: "#bbb", fontWeight: 400 }}>Enter a firm name to research</p>
                    <p style={{ fontSize: 12, color: "#ddd", marginTop: 6 }}>3-pass deep scan: senior departures, spinouts, then a final sweep</p>
                  </div>
                )}

                {activeFirmData && (
                  <div style={{ animation: "fadeIn .3s ease" }}>
                    <div style={{ marginBottom: 20 }}>
                      <h2 style={{ fontSize: 22, fontWeight: 600, color: "#111", letterSpacing: "-0.02em" }}>{activeFirmData.name}</h2>
                      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, color: "#999" }}>Last scanned {new Date(activeFirmData.lastResearched).toLocaleDateString()}</span>
                        <button onClick={() => researchFirm(activeFirmData.name)} disabled={researching} style={{ fontSize: 11, color: "#111", background: "none", border: "1px solid #e5e5e5", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>Re-scan</button>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
                      <input className="mono" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Filter…" style={{ padding: "6px 10px", fontSize: 12, background: "#fafafa", border: "1px solid #e5e5e5", borderRadius: 4, color: "#111", outline: "none", width: 160 }} />
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {destTypes.map(([val, label]) => (
                          <button key={val} onClick={() => setFilterDest(val)} style={{ padding: "4px 10px", fontSize: 11, background: filterDest === val ? "#111" : "transparent", color: filterDest === val ? "#fff" : "#999", border: "1px solid", borderColor: filterDest === val ? "#111" : "#e5e5e5", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <select className="mono" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ padding: "5px 8px", fontSize: 11, background: "#fafafa", border: "1px solid #e5e5e5", borderRadius: 4, color: "#666", outline: "none", cursor: "pointer", marginLeft: "auto" }}>
                        <option value="year_desc">Newest first</option>
                        <option value="year_asc">Oldest first</option>
                        <option value="name">By name</option>
                      </select>
                    </div>

                    {filteredPeople.length === 0 ? (
                      <div style={{ textAlign: "center", padding: "40px 20px", color: "#ccc", fontSize: 13 }}>No results</div>
                    ) : (
                      <div>
                        {(() => {
                          let lastYear = null;
                          return filteredPeople.map((p, i) => {
                            const year = p.departure_year?.slice(0, 4) || "Unknown";
                            const showYear = sortBy !== "name" && year !== lastYear;
                            lastYear = year;
                            const isExpanded = expandedId === p._id;
                            return (
                              <div key={p._id} style={{ animation: "slideIn .25s ease both", animationDelay: `${i * .02}s` }}>
                                {showYear && (
                                  <div className="mono" style={{ fontSize: 11, fontWeight: 500, color: "#999", padding: "16px 0 6px", borderBottom: "1px solid #f0f0f0", marginBottom: 8, letterSpacing: "0.04em" }}>{year}</div>
                                )}
                                <div onClick={() => setExpandedId(isExpanded ? null : p._id)} style={{ padding: "12px 0", borderBottom: "1px solid #f5f5f5", cursor: "pointer", transition: "background 0.1s" }} onMouseEnter={(e) => e.currentTarget.style.background = "#fafafa"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ fontSize: 14, fontWeight: 500, color: "#111" }}>{p.name}</div>
                                      <div className="mono" style={{ fontSize: 12, color: "#888", fontWeight: 300, marginTop: 1 }}>{p.former_title}</div>
                                    </div>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                      <span className="mono" style={{ fontSize: 10, color: "#bbb" }}>{isExpanded ? "−" : "+"}</span>
                                      <button onClick={(e) => { e.stopPropagation(); removePerson(activeFirm, p._id); }} style={{ background: "none", border: "none", color: "#ddd", fontSize: 14, cursor: "pointer", padding: "2px 4px" }}>×</button>
                                    </div>
                                  </div>
                                  <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                    <span className="mono" style={{ fontSize: 10, padding: "2px 8px", background: p.destination_type === "spinout" ? "#111" : "#f5f5f5", color: p.destination_type === "spinout" ? "#fff" : "#888", borderRadius: 3, textTransform: "capitalize", fontWeight: 400 }}>
                                      {p.destination_type?.replace("_", " ") || "unknown"}
                                    </span>
                                    <span style={{ fontSize: 13, color: "#444", fontWeight: 400 }}>{p.destination || "Unknown"}</span>
                                  </div>
                                  {isExpanded && (
                                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #f0f0f0", animation: "fadeIn .2s ease", display: "grid", gap: 8 }}>
                                      {p.new_fund_strategy && (<div><div className="mono" style={{ fontSize: 9, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Strategy</div><div style={{ fontSize: 12, color: "#555" }}>{p.new_fund_strategy}</div></div>)}
                                      {p.fund_size && (<div><div className="mono" style={{ fontSize: 9, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Fund Size</div><div style={{ fontSize: 12, color: "#555" }}>{p.fund_size}</div></div>)}
                                      {p.current_role && (<div><div className="mono" style={{ fontSize: 9, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Current Role</div><div style={{ fontSize: 12, color: "#555" }}>{p.current_role}</div></div>)}
                                      {p.notable_deals && (<div><div className="mono" style={{ fontSize: 9, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Notable Deals</div><div style={{ fontSize: 12, color: "#555" }}>{p.notable_deals}</div></div>)}
                                      {p.departure_year && p.departure_year !== "Unknown" && (<div><div className="mono" style={{ fontSize: 9, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Departed</div><div style={{ fontSize: 12, color: "#555" }}>{p.departure_year}</div></div>)}
                                      {p.source && (<div><div className="mono" style={{ fontSize: 9, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Source</div><div className="mono" style={{ fontSize: 11, color: "#aaa" }}>{p.source}</div></div>)}
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
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
