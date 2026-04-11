// content/fuzzyAnchor.js

window.FuzzyAnchor = {
  /**
   * Generates a fuzzy anchor for the given HTML element.
   * @param {HTMLElement} element 
   * @returns {Object} anchor object
   */
  generate(element) {
    return {
      directSelector: this._getDirectSelector(element),
      structuralPath: this._getXPath(element),
      semanticAnchor: this._getSemanticAnchor(element),
      visualGeometry: this._getVisualGeometry(element),
      tagName: element.tagName.toLowerCase()
    };
  },

  /**
   * Tries to find the best match for the given anchor on the current page.
   * @param {Object} anchor 
   * @returns {Object} { element: HTMLElement|null, confidence: number }
   */
  findMatch(anchor) {
    if (!anchor) return { element: null, confidence: 0 };

    let candidate = null;
    let confidence = 0;

    // 1. Direct Selector (Score base: 70%)
    if (anchor.directSelector) {
      try {
        const el = document.querySelector(anchor.directSelector);
        if (el && el.tagName.toLowerCase() === anchor.tagName) {
          return { element: el, confidence: 95 }; // Very high confidence
        }
      } catch (e) {}
    }

    // 2. Structural Path (Score base: 40%)
    if (anchor.structuralPath) {
      try {
        const result = document.evaluate(
          anchor.structuralPath, 
          document, 
          null, 
          XPathResult.FIRST_ORDERED_NODE_TYPE, 
          null
        );
        candidate = result.singleNodeValue;
        if (candidate && candidate.tagName.toLowerCase() === anchor.tagName) {
          confidence += 40;
        } else {
          candidate = null;
        }
      } catch (e) {}
    }

    // 3. Semantic (Text) Boost (Score base: +50%)
    if (candidate && anchor.semanticAnchor) {
      const currentText = this._getSemanticAnchor(candidate);
      if (currentText === anchor.semanticAnchor) {
        confidence += 50; 
      }
    } else if (!candidate && anchor.semanticAnchor) {
      // Basic fallback: search by text
      const elements = document.getElementsByTagName(anchor.tagName);
      for (const el of elements) {
        if (this._getSemanticAnchor(el) === anchor.semanticAnchor) {
          candidate = el;
          confidence = 70; // Good enough
          break;
        }
      }
    }

    // 4. Visual Geometry Fallback (If still no candidate, e.g. purely structural iframes/images)
    if (!candidate && anchor.visualGeometry) {
      const elements = document.getElementsByTagName(anchor.tagName);
      for (const el of elements) {
        const geom = this._getVisualGeometry(el);
        if (
          geom &&
          geom.nearestLandmarkTag === anchor.visualGeometry.nearestLandmarkTag &&
          Math.abs(geom.rect.top - anchor.visualGeometry.rect.top) < 150 && 
          Math.abs(geom.rect.left - anchor.visualGeometry.rect.left) < 150
        ) {
          candidate = el;
          confidence = 65; // Visual geometry is weak (<70 threshold)
          break;
        }
      }
    }

    return { element: candidate, confidence };
  },

  _getDirectSelector(el) {
    if (el.id && !/^\d+$/.test(el.id)) { // Ignore purely numeric IDs
      return `#${el.id}`;
    }
    return null;
  },

  _getXPath(element) {
    if (element.id !== '') {
      return 'id("' + element.id + '")';
    }
    if (element === document.body) {
      return element.tagName.toLowerCase();
    }
    let ix = 0;
    const siblings = element.parentNode ? element.parentNode.childNodes : [];
    for (let i = 0; i < siblings.length; i++) {
        const sibling = siblings[i];
        if (sibling === element) {
            return this._getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
        }
        if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
            ix++;
        }
    }
    return null;
  },

  _getSemanticAnchor(el) {
    const text = el.innerText || el.textContent || '';
    const cleanText = text.replace(/\s+/g, ' ').trim();
    if (!cleanText) return null;
    
    if (cleanText.length <= 40) return cleanText;
    return cleanText.substring(0, 20) + '...' + cleanText.substring(cleanText.length - 20);
  },

  _getVisualGeometry(el) {
    let landmark = el.closest('header, main, article, footer, aside, nav, section');
    if (!landmark) return null;

    const landmarkRect = landmark.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    return {
      nearestLandmarkTag: landmark.tagName.toLowerCase(),
      rect: {
        top: elRect.top - landmarkRect.top,
        left: elRect.left - landmarkRect.left,
        width: elRect.width,
        height: elRect.height
      }
    };
  }
};
