// content/fuzzyAnchor.js — Candidate Tournament Anchor System

window.FuzzyAnchor = {

  // ─── Stopwords filtered from text fingerprints ──────────────────────────────
  _stopwords: new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with',
    'by','from','is','it','as','be','was','are','were','been','has','had',
    'have','do','does','did','will','would','could','should','can','may',
    'not','no','so','if','then','than','that','this','these','those','its',
    'i','we','you','he','she','they','me','us','him','her','them','my',
    'our','your','his','their','all','each','every','some','any','most',
  ]),

  // ─── Auto-generated class patterns (CSS-in-JS, etc.) ────────────────────────
  _autoClassPattern: /^(css|sc|styled|emotion|_)-?[a-z0-9]{4,}$|^[a-z]{1,3}[A-Z][a-zA-Z0-9]{3,}$|^_[a-z0-9]{5,}$/,

  // ─── Stable attributes worth capturing ──────────────────────────────────────
  _stableAttrs: [
    'data-testid', 'data-id', 'data-name', 'data-type', 'data-slot',
    'data-section', 'data-block', 'data-component',
    'role', 'aria-label', 'name', 'type', 'alt', 'title', 'placeholder',
    'href', 'src',
  ],

  // ═══════════════════════════════════════════════════════════════════════════
  //  GENERATE — capture rich anchor signals for an element
  // ═══════════════════════════════════════════════════════════════════════════

  generate(element) {
    return {
      cssSelector: this.generateCSSSelector(element),
      tagName: element.tagName.toLowerCase(),
      textFingerprint: this._getTextFingerprint(element),
      attributes: this._getAttributes(element),
      structure: this._getStructure(element),
      geometry: this._getGeometry(element),
    };
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  GENERATE CSS SELECTOR — shared utility (also used by resizer)
  // ═══════════════════════════════════════════════════════════════════════════

  generateCSSSelector(el) {
    // 1. Stable ID (unique on page, valid CSS identifier)
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
      if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        return '#' + CSS.escape(el.id);
      }
    }

    // 2. Unique class combination (filter auto-generated classes)
    if (el.classList.length > 0) {
      const classes = Array.from(el.classList)
        .filter(c => !c.startsWith('vellum-') && /^[a-zA-Z][\w-]*$/.test(c) && !this._autoClassPattern.test(c));
      if (classes.length > 0) {
        const selector = el.tagName.toLowerCase() + '.' + classes.map(c => CSS.escape(c)).join('.');
        try {
          if (document.querySelectorAll(selector).length === 1) return selector;
        } catch { }
      }
    }

    // 3. Stable attribute selector
    for (const attr of ['data-testid', 'data-id', 'role', 'name']) {
      const val = el.getAttribute(attr);
      if (val) {
        const selector = el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(val) + ']';
        try {
          if (document.querySelectorAll(selector).length === 1) return selector;
        } catch { }
      }
    }

    // 4. Structural nth-child path (weakest — breaks when siblings change)
    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(current) + 1;
      const tag = current.tagName.toLowerCase();
      parts.unshift(`${tag}:nth-child(${index})`);
      // Anchor to an ID if we find one along the way
      if (current.id && /^[a-zA-Z][\w-]*$/.test(current.id)) {
        parts[0] = '#' + CSS.escape(current.id);
        break;
      }
      current = parent;
    }
    return parts.join(' > ');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  FIND MATCH — candidate tournament
  // ═══════════════════════════════════════════════════════════════════════════

  findMatch(anchor) {
    if (!anchor) return { element: null, confidence: 0 };

    // ── Phase A: Collect candidates ─────────────────────────────────────────
    const candidateSet = new Set();

    // A1. CSS selector match
    if (anchor.cssSelector) {
      try {
        const el = document.querySelector(anchor.cssSelector);
        if (el) candidateSet.add(el);
      } catch { }
    }

    // A2. Attribute-based queries
    if (anchor.attributes) {
      for (const attr of ['data-testid', 'data-id', 'role', 'name']) {
        const val = anchor.attributes[attr];
        if (val) {
          try {
            const el = document.querySelector(
              anchor.tagName + '[' + attr + '=' + JSON.stringify(val) + ']'
            );
            if (el) candidateSet.add(el);
          } catch { }
        }
      }
    }

    // A3. Tag scan with quick text filter
    if (anchor.tagName) {
      const elements = document.getElementsByTagName(anchor.tagName);
      const limit = Math.min(elements.length, 200);
      for (let i = 0; i < limit; i++) {
        const el = elements[i];
        // Quick check: skip hidden elements and Vellum UI
        if (el.offsetHeight === 0 && el.offsetWidth === 0) continue;
        if (el.closest('[data-vellum-ui]')) continue;
        // Add if any text word overlap, or if element has no text (images, etc.)
        if (anchor.textFingerprint && anchor.textFingerprint.words.length > 0) {
          if (this._quickTextOverlap(el, anchor.textFingerprint)) {
            candidateSet.add(el);
          }
        } else {
          // For elements with no text fingerprint (images, iframes), add all of same tag
          candidateSet.add(el);
        }
      }
    }

    // ── Phase B: Score every candidate ──────────────────────────────────────
    let bestElement = null;
    let bestScore = 0;

    for (const el of candidateSet) {
      const score = this._scoreCandidate(el, anchor);

      // Short-circuit: high-confidence CSS selector match
      if (score > 85) return { element: el, confidence: score };

      if (score > bestScore) {
        bestScore = score;
        bestElement = el;
      }
    }

    // ── Phase C: Return best above threshold ────────────────────────────────
    if (bestScore >= 40 && bestElement) {
      return { element: bestElement, confidence: bestScore };
    }

    return { element: null, confidence: 0 };
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  SCORING
  // ═══════════════════════════════════════════════════════════════════════════

  _scoreCandidate(el, anchor) {
    let score = 0;

    // Signal 1: CSS selector (max 30)
    if (anchor.cssSelector) {
      try {
        if (el.matches(anchor.cssSelector)) score += 30;
      } catch { }
    }

    // Signal 2: Tag name (max 5)
    if (el.tagName.toLowerCase() === anchor.tagName) {
      score += 5;
    } else {
      return score; // Wrong tag — unlikely to be the right element
    }

    // Signal 3: Text similarity (max 30)
    if (anchor.textFingerprint) {
      score += this._textScore(el, anchor.textFingerprint);
    }

    // Signal 4: Attributes (max 15)
    if (anchor.attributes) {
      score += this._attributeScore(el, anchor.attributes);
    }

    // Signal 5: Structure (max 10)
    if (anchor.structure) {
      score += this._structureScore(el, anchor.structure);
    }

    // Signal 6: Geometry (max 10)
    if (anchor.geometry) {
      score += this._geometryScore(el, anchor.geometry);
    }

    return score;
  },

  // ── Text similarity scoring (max 30) ──────────────────────────────────────

  _textScore(el, fingerprint) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text && fingerprint.words.length === 0) return 20; // Both empty — partial match
    if (!text || fingerprint.words.length === 0) return 0;

    const elWords = this._extractWords(text);
    if (elWords.length === 0) return 0;

    // Jaccard similarity on distinctive words
    const storedSet = new Set(fingerprint.words);
    const elSet = new Set(elWords.slice(0, 50));
    let intersection = 0;
    for (const w of storedSet) {
      if (elSet.has(w)) intersection++;
    }
    const union = new Set([...storedSet, ...elSet]).size;
    let similarity = union > 0 ? intersection / union : 0;

    // Prefix bonus
    if (fingerprint.prefix) {
      const elPrefix = elWords.slice(0, 5).join(' ');
      const storedPrefix = fingerprint.prefix;
      if (elPrefix === storedPrefix) {
        similarity += 0.15;
      } else if (elPrefix.startsWith(storedPrefix.split(' ').slice(0, 3).join(' '))) {
        similarity += 0.08;
      }
    }

    // Suffix bonus
    if (fingerprint.suffix) {
      const elSuffix = elWords.slice(-5).join(' ');
      const storedSuffix = fingerprint.suffix;
      if (elSuffix === storedSuffix) {
        similarity += 0.15;
      } else if (elSuffix.endsWith(storedSuffix.split(' ').slice(-3).join(' '))) {
        similarity += 0.08;
      }
    }

    // Word count proximity bonus
    if (fingerprint.wordCount > 0) {
      const ratio = Math.min(elWords.length, fingerprint.wordCount) / Math.max(elWords.length, fingerprint.wordCount);
      if (ratio > 0.8) similarity += 0.1;
    }

    return Math.min(30, Math.round(Math.min(1, similarity) * 30));
  },

  // ── Attribute scoring (max 15) ────────────────────────────────────────────

  _attributeScore(el, storedAttrs) {
    const keys = Object.keys(storedAttrs);
    if (keys.length === 0) return 0;

    let matches = 0;
    for (const key of keys) {
      const elVal = el.getAttribute(key);
      if (elVal === storedAttrs[key]) matches++;
    }

    return Math.round((matches / keys.length) * 15);
  },

  // ── Structure scoring (max 10) ────────────────────────────────────────────

  _structureScore(el, storedStructure) {
    let score = 0;
    const parent = el.parentElement;

    // Parent tag match (3 points)
    if (parent && parent.tagName.toLowerCase() === storedStructure.parentTag) {
      score += 3;
    }

    // Parent class overlap (3 points)
    if (parent && storedStructure.parentClasses && storedStructure.parentClasses.length > 0) {
      const parentClasses = Array.from(parent.classList);
      let overlap = 0;
      for (const c of storedStructure.parentClasses) {
        if (parentClasses.includes(c)) overlap++;
      }
      score += Math.round((overlap / storedStructure.parentClasses.length) * 3);
    }

    // Child count proximity (2 points)
    if (storedStructure.childCount !== undefined) {
      const childCount = el.children.length;
      const ratio = Math.min(childCount, storedStructure.childCount) /
                    Math.max(childCount, storedStructure.childCount, 1);
      score += Math.round(ratio * 2);
    }

    // Child tags sequence similarity (2 points)
    if (storedStructure.childTags && storedStructure.childTags.length > 0) {
      const currentChildTags = Array.from(el.children).map(c => c.tagName.toLowerCase());
      if (currentChildTags.length > 0) {
        // Compare first N tags
        const len = Math.min(currentChildTags.length, storedStructure.childTags.length, 10);
        let matching = 0;
        for (let i = 0; i < len; i++) {
          if (currentChildTags[i] === storedStructure.childTags[i]) matching++;
        }
        score += Math.round((matching / len) * 2);
      }
    }

    return score;
  },

  // ── Geometry scoring (max 10) ──────────────────────────────────────────────

  _geometryScore(el, storedGeo) {
    const rect = el.getBoundingClientRect();
    const vpW = window.innerWidth || 1;
    const vpH = window.innerHeight || 1;
    const docH = Math.max(document.documentElement.scrollHeight, 1);
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;

    const xRatio = rect.left / vpW;
    const yRatio = (rect.top + scrollY) / docH;
    const widthRatio = rect.width / vpW;

    // Euclidean distance on position ratios
    const dx = xRatio - storedGeo.xRatio;
    const dy = yRatio - storedGeo.yRatio;
    const positionDist = Math.sqrt(dx * dx + dy * dy);

    // Size similarity bonus
    const widthDiff = Math.abs(widthRatio - storedGeo.widthRatio);

    // Position contributes up to 7 points, size up to 3 points
    const positionScore = Math.max(0, 7 * (1 - positionDist / 0.3));
    const sizeScore = Math.max(0, 3 * (1 - widthDiff / 0.2));

    return Math.min(10, Math.round(positionScore + sizeScore));
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _getTextFingerprint(el) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) return { words: [], prefix: null, suffix: null, wordCount: 0, length: 0 };

    const allWords = text.split(/[\s\p{P}]+/u).filter(w => w.length > 1);
    const distinctiveWords = allWords.filter(w => !this._stopwords.has(w));
    const prefixWords = allWords.slice(0, 5);
    const suffixWords = allWords.slice(-5);

    // Sample up to 10 distinctive words spread across the content
    let sampled;
    if (distinctiveWords.length <= 10) {
      sampled = distinctiveWords;
    } else {
      sampled = [];
      const step = distinctiveWords.length / 10;
      for (let i = 0; i < 10; i++) {
        sampled.push(distinctiveWords[Math.floor(i * step)]);
      }
    }

    return {
      words: sampled,
      prefix: prefixWords.join(' '),
      suffix: suffixWords.join(' '),
      wordCount: allWords.length,
      length: text.length,
    };
  },

  _getAttributes(el) {
    const attrs = {};
    for (const attr of this._stableAttrs) {
      const val = el.getAttribute(attr);
      if (val) attrs[attr] = val;
    }
    return attrs;
  },

  _getStructure(el) {
    const parent = el.parentElement;
    let depth = 0;
    let current = el;
    while (current && current !== document.body) {
      depth++;
      current = current.parentElement;
    }

    return {
      parentTag: parent ? parent.tagName.toLowerCase() : null,
      parentClasses: parent
        ? Array.from(parent.classList).filter(c => !this._autoClassPattern.test(c))
        : [],
      childCount: el.children.length,
      childTags: Array.from(el.children).slice(0, 10).map(c => c.tagName.toLowerCase()),
      depth,
    };
  },

  _getGeometry(el) {
    const rect = el.getBoundingClientRect();
    const vpW = window.innerWidth || 1;
    const vpH = window.innerHeight || 1;
    const docH = Math.max(document.documentElement.scrollHeight, 1);
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;

    return {
      xRatio: parseFloat((rect.left / vpW).toFixed(4)),
      yRatio: parseFloat(((rect.top + scrollY) / docH).toFixed(4)),
      widthRatio: parseFloat((rect.width / vpW).toFixed(4)),
      heightRatio: parseFloat((rect.height / vpH).toFixed(4)),
    };
  },

  _extractWords(text) {
    return text.split(/[\s\p{P}]+/u).filter(w => w.length > 1 && !this._stopwords.has(w));
  },

  /** Quick check: does the element share at least one distinctive word with the fingerprint? */
  _quickTextOverlap(el, fingerprint) {
    const text = (el.innerText || el.textContent || '').toLowerCase();
    if (!text) return false;
    for (const word of fingerprint.words) {
      if (text.includes(word)) return true;
    }
    return false;
  },
};
