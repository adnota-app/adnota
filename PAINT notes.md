  Definitely improvements (revert these only if I'm wrong about something)            
                                                                                      
  1. Zero-rect demotion in restorer — without this, hidden anchors collapse markers to
   viewport (0, 0). Strictly better. Handles WPUPG-style filter UIs but also any
  general "anchor element is hidden" case.                                            
  2. Zero-rect skip in bindAnchorSync — same principle, prevents ResizeObserver
  dragging a placed marker to origin on a display: block → none transition. Strictly  
  better.
  3. Fallback upgrade-on-hydration (fallbackOnlyItems) — fixes a real bug where       
  processedItems.add after a fallback render locked the marker permanently. Now       
  re-attempts on subsequent passes. Strictly better.
  4. identifiers field in FuzzyAnchor.generate — purely additive, captures unique     
  signals (data-id, idClass, href) from the ancestor chain. Old code paths don't read 
  it. Improves Phase 0 match resilience for new annotations.
  5. Phase 0 identity-first lookup in findMatch — short-circuits to confidence 100    
  when identifiers resolve uniquely; falls through to the existing tournament         
  unchanged otherwise. Pure win for new annotations.
  6. syncTextPos/syncBounds reading wrapper._adnotaAnchorElement instead of closure — 
  necessary refactor for live re-resolve to work, but behavior is identical when      
  re-resolve doesn't fire.
                                                                                      
  Likely improvements but adds complexity                                             
   
  7. Navigation API zero-latency hide — clean UX win for SPA navigation, gated on     
  Chrome 102+. Could in theory cause unwanted flicker on sites that pushState during
  normal interaction. Untested broadly.                                               
  8. MutationObserver attribute filter (style, class) — catches more lazy-load
  patterns. Slightly more wakeups but bounded by 1s debounce. No clear downside seen. 
  9. Staggered safety-net retries (1s, 3s, 8s) — defensive, cheap because of dedupe.
  No realistic downside.                                                              
  10. bindAnchorSync live-anchor re-resolution — kicks in only when zero-rect; when
  identifiers are good, this is exactly what made WPUPG markers snap to the right     
  card. Quality depends on identifier uniqueness. 






Q: were all our changes only with the PAINT tool? Or something else?                   
                                                                    
⏺ No, several changes touch shared layers that affect other tools too. Here's the     
  actual scope:                          
                                                                                      
  Marker (PAINT) — directly affected
                                                                                      
  - Zero-rect demotion in restorer (gated on action === 'MARKER')                     
  - fallbackOnlyItems upgrade logic (MARKER branch only)
  - syncTextPos / syncBounds wrapper-prop reads (marker-specific)                     
                                                                                      
  Shared layers — affect multiple tools                                               
                                                                                      
  bindAnchorSync changes (zero-rect skip, live-anchor re-resolve) flow through to     
  every wrapper that uses it, per the existing architecture:
  - Marker text wrappers                                                              
  - Marker SVG wrappers                                                               
  - Highlighter fallback wrappers (the overlay path when CSS Custom Highlights API
  isn't available)                                                                    
                                                                                      
  FuzzyAnchor changes (_getIdentifiers, Phase 0 identity-first lookup,
  _resolveByIdentifiers prefer-visible) affect every tool that calls                  
  FuzzyAnchor.generate or findMatch:                        
  - New annotations from MARKER, HIGHLIGHT, NOTE, ERASE, RESIZE all now save the      
  identifiers field                                                                   
  - Restoration for MARKER, NOTE, and the ERASE inline-fallback sidecar all benefit
  from Phase 0 lookup                                                                 
  - ERASE/RESIZE primary paths are CSS injection, which doesn't touch FuzzyAnchor —   
  those are unchanged                                                              
                                                                                      
  adnotaUI.css adnota-route-changing rule hides three containers during SPA
  navigation:                                                                         
  - #adnota-marker-overlay (marker)                         
  - .adnota-highlight-fallback (highlight)                                            
  - .adnota-sticky-container (sticky note)                  
                                                                                      
  restorer.js MutationObserver attribute filter + staggered retries + Navigation API  
  listener re-run the whole restoration loop, so any wakeup affects all action types. 
                                                                                      
  Practical impact                                                                    
                                                            
  - Sticky notes: get Phase 0 identity-first matching for free. Probable improvement, 
  untested by us.
  - Highlight fallbacks: get the same bindAnchorSync improvements as markers. Probable
   improvement.                                                                       
  - Eraser: primary path (CSS rule injection) unchanged. Inline-style sidecar fires
  findMatch on existing items, which now uses Phase 0 — but the sidecar is best-effort
   so behavior is largely unchanged.                        
  - Resizer: primary path (CSS rule injection) unchanged. Phase 0 isn't load-bearing  
  here.                                                                               
   
  What this means for your "take another stab" plan                                   
                                                            
  If you revert, the boundaries to think about:                                       
  - Reverting bindAnchorSync changes affects markers + highlight fallbacks.
  - Reverting FuzzyAnchor changes affects every tool (though most via additive fields 
  that older code ignores).                                                          
  - Reverting restorer.js changes affects the whole restoration pipeline.             
                                                                         
  The two items I flagged as uncertain in the previous message (_resolveByIdentifiers 
  prefer-visible, and capturing data-grid-id as an identifier) live entirely in       
  FuzzyAnchor — so a targeted revert there would affect all tools' identity-first     
  lookup but not the bindAnchorSync zero-rect / re-resolve work for markers and       
  highlights.