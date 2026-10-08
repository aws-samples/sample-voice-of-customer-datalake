/**
 * VoC Feedback Form Widget
 * Embeddable Typeform-style feedback widget for Voice of Customer platform.
 * 
 * Usage:
 *   VoCFeedbackForm.init({
 *     container: '#voc-feedback-form',
 *     apiEndpoint: 'https://api.example.com/v1',
 *     formId: 'abc123',
 *     configEndpoint: '/feedback-forms/abc123/config',
 *     submitEndpoint: '/feedback-forms/abc123/submit'
 *   });
 */
(function() {
  // Defaults from the Kiro Light palette (docs/kiro-design-system.md): accent,
  // page background, strong text, muted text, borders. A form's own theme
  // colours always win; these apply only where the form leaves one unset.
  var KIRO = {
    primary: '#8e48ff',
    background: '#ffffff',
    text: '#19161d',
    muted: '#5e5966',
    border: '#d4d4d8',
    borderSubtle: '#e4e4e7'
  };

  /** WCAG relative luminance of a #rgb / #rrggbb colour, or null for anything else. */
  function luminance(colour) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(colour || '').trim());
    if (!m) return null;
    var hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    var channels = [0, 2, 4].map(function(i) {
      var channel = parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrast(a, b) {
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  /**
   * The text colour for a label ON `fill` (the start/next/selected buttons):
   * white or Kiro strong text, whichever contrasts more. Keeps a customer's
   * brand colour as the fill while the label stays readable; the old fixed
   * white label failed WCAG AA on the old blue default (3.68:1, E2E F6).
   * Anything that is not a hex colour keeps white.
   */
  function readableOn(fill) {
    var l = luminance(fill);
    if (l === null) return '#ffffff';
    return contrast(l, 1) >= contrast(l, luminance(KIRO.text)) ? '#ffffff' : KIRO.text;
  }

  function message(container, text) {
    container.innerHTML = '';
    var p = document.createElement('p');
    p.setAttribute('role', 'status');
    p.style.cssText = 'color:' + KIRO.muted + ';text-align:center;padding:40px;';
    p.textContent = text;
    container.appendChild(p);
  }

  window.VoCFeedbackForm = {
    init: function(options) {
      var container = document.querySelector(options.container);
      if (!container) return;
      var apiEndpoint = (options.apiEndpoint || '').replace(/\/+$/, '');
      if (!apiEndpoint) return;
      var configEndpoint = options.configEndpoint || '/feedback-forms/' + options.formId + '/config';
      var submitEndpoint = options.submitEndpoint || '/feedback-forms/' + options.formId + '/submit';
      fetch(apiEndpoint + configEndpoint)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var config = data.config || data;
          if (data.success && config && config.enabled) {
            new TypeformWidget(container, config, apiEndpoint, submitEndpoint, embedDimensions(options.dimensions));
          } else {
            message(container, 'Feedback form unavailable.');
          }
        })
        .catch(function() {
          message(container, 'Failed to load form.');
        });
    }
  };

  // The `dimensions` embed option ({product: 'app', user_type: 'partner'}): kept
  // only as a plain object of up to 10 string/number values. The server drops
  // anything the deployment's dimensions config does not know.
  var MAX_EMBED_DIMENSIONS = 10;
  function embedDimensions(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var out = {};
    var count = 0;
    Object.keys(raw).forEach(function(key) {
      var value = raw[key];
      var usable = typeof value === 'string' || (typeof value === 'number' && isFinite(value));
      if (usable && count < MAX_EMBED_DIMENSIONS) {
        out[key] = String(value);
        count += 1;
      }
    });
    return count ? out : null;
  }

  function TypeformWidget(container, config, apiEndpoint, submitEndpoint, dimensions) {
    this.container = container;
    this.config = config;
    this.apiEndpoint = apiEndpoint;
    this.submitEndpoint = submitEndpoint;
    this.dimensions = dimensions || null;
    this.currentStep = 0;
    this.data = { rating: null, text: '', name: '', email: '' };
    this.isSubmitting = false;
    this.steps = this.buildSteps();
    this.render();
  }

  TypeformWidget.prototype.buildSteps = function() {
    var steps = [], c = this.config;
    steps.push({ type: 'welcome', title: c.title, subtitle: c.description });
    if (c.rating_enabled) {
      steps.push({ type: 'rating', title: c.question, ratingType: c.rating_type, max: c.rating_max || 5 });
    }
    steps.push({ type: 'text', title: 'Tell us more', placeholder: c.placeholder });
    if (c.collect_name) {
      steps.push({ type: 'name', title: "What's your name?", placeholder: 'Type your name...' });
    }
    if (c.collect_email) {
      steps.push({ type: 'email', title: "What's your email?", placeholder: 'name@example.com' });
    }
    steps.push({ type: 'thanks', title: c.success_message || 'Thank you!' });
    return steps;
  };

  TypeformWidget.prototype.render = function() {
    var t = this.config.theme || {};
    var primary = t.primary_color || KIRO.primary;
    var onPrimary = readableOn(primary);
    var bg = t.background_color || KIRO.background;
    var text = t.text_color || KIRO.text;

    this.container.innerHTML = '';
    this.container.style.cssText = 'position:relative;min-height:400px;background:' + bg + ';color:' + text + ';font-family:system-ui,-apple-system,sans-serif;overflow:hidden;';

    // Progress bar
    var progress = document.createElement('div');
    progress.style.cssText = 'position:absolute;top:0;left:0;height:4px;background:' + primary + ';transition:width 0.3s ease;width:0%;z-index:10;';
    this.container.appendChild(progress);
    this.progressBar = progress;

    // Slides container
    var slides = document.createElement('div');
    slides.style.cssText = 'height:100%;min-height:400px;position:relative;';
    this.container.appendChild(slides);
    this.slidesContainer = slides;

    var self = this;
    this.steps.forEach(function(step, i) {
      slides.appendChild(self.createSlide(step, i));
    });

    // Navigation
    var nav = document.createElement('div');
    nav.style.cssText = 'position:absolute;bottom:20px;right:20px;display:flex;gap:8px;';

    var prevBtn = document.createElement('button');
    prevBtn.innerHTML = '&uarr;';
    prevBtn.setAttribute('aria-label', 'Previous question');
    prevBtn.style.cssText = 'width:40px;height:40px;border:1px solid ' + KIRO.border + ';background:' + KIRO.background + ';color:' + KIRO.text + ';border-radius:4px;cursor:pointer;font-size:18px;';
    prevBtn.onclick = function() { self.prev(); };
    this.prevBtn = prevBtn;

    var nextBtn = document.createElement('button');
    nextBtn.innerHTML = '&darr;';
    nextBtn.setAttribute('aria-label', 'Next question');
    nextBtn.style.cssText = 'width:40px;height:40px;border:none;background:' + primary + ';color:' + onPrimary + ';border-radius:4px;cursor:pointer;font-size:18px;';
    nextBtn.onclick = function() { self.next(); };
    this.nextBtn = nextBtn;

    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    this.container.appendChild(nav);
    this.nav = nav;

    // Keyboard navigation
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) self.next();
      if (e.key === 'ArrowDown') self.next();
      if (e.key === 'ArrowUp') self.prev();
    });

    this.goToStep(0);
  };

  TypeformWidget.prototype.createSlide = function(step, index) {
    var self = this;
    var t = this.config.theme || {};
    var primary = t.primary_color || KIRO.primary;

    var slide = document.createElement('div');
    slide.dataset.index = index;
    slide.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:40px;box-sizing:border-box;opacity:0;transform:translateY(20px);transition:opacity 0.4s ease,transform 0.4s ease;pointer-events:none;';

    var content = document.createElement('div');
    content.style.cssText = 'max-width:600px;width:100%;text-align:center;';

    if (step.type === 'welcome') {
      var h1 = document.createElement('h1');
      h1.style.cssText = 'font-size:32px;font-weight:700;margin:0 0 16px;';
      h1.textContent = step.title;
      var p = document.createElement('p');
      p.style.cssText = 'font-size:18px;opacity:0.7;margin:0 0 32px;';
      p.textContent = step.subtitle;
      var btn = document.createElement('button');
      btn.className = 'voc-start';
      btn.style.cssText = 'background:' + primary + ';color:' + readableOn(primary) + ';border:none;padding:16px 32px;font-size:16px;border-radius:8px;cursor:pointer;';
      btn.innerHTML = 'Start &rarr;';
      btn.onclick = function() { self.next(); };
      content.appendChild(h1);
      content.appendChild(p);
      content.appendChild(btn);
    } else if (step.type === 'rating') {
      this.createRatingSlide(content, step, primary);
    } else if (step.type === 'text') {
      var h2 = document.createElement('h2');
      h2.style.cssText = 'font-size:28px;font-weight:600;margin:0 0 24px;';
      h2.textContent = step.title;
      var ta = document.createElement('textarea');
      ta.className = 'voc-input';
      ta.placeholder = step.placeholder;
      ta.style.cssText = 'width:100%;min-height:150px;padding:16px;font-size:18px;border:2px solid ' + KIRO.borderSubtle + ';border-radius:12px;resize:none;font-family:inherit;box-sizing:border-box;';
      ta.oninput = function() { self.data.text = this.value; };
      ta.onkeydown = function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); self.next(); } };
      var hint = document.createElement('p');
      hint.style.cssText = 'margin-top:16px;font-size:14px;opacity:0.5;';
      hint.textContent = 'Press Enter to continue';
      content.appendChild(h2);
      content.appendChild(ta);
      content.appendChild(hint);
    } else if (step.type === 'name' || step.type === 'email') {
      var h2 = document.createElement('h2');
      h2.style.cssText = 'font-size:28px;font-weight:600;margin:0 0 24px;';
      h2.textContent = step.title;
      var inp = document.createElement('input');
      inp.type = step.type === 'email' ? 'email' : 'text';
      inp.className = 'voc-input';
      inp.placeholder = step.placeholder;
      inp.style.cssText = 'width:100%;padding:16px;font-size:24px;border:none;border-bottom:2px solid ' + KIRO.borderSubtle + ';text-align:center;outline:none;background:transparent;';
      inp.oninput = function() { self.data[step.type] = this.value; };
      inp.onkeydown = function(e) { if (e.key === 'Enter') self.next(); };
      content.appendChild(h2);
      content.appendChild(inp);
    } else if (step.type === 'thanks') {
      var checkmark = document.createElement('div');
      checkmark.style.cssText = 'font-size:64px;margin-bottom:24px;';
      checkmark.innerHTML = '&#10003;';
      var h2 = document.createElement('h2');
      h2.style.cssText = 'font-size:32px;font-weight:600;margin:0;';
      h2.textContent = step.title;
      content.appendChild(checkmark);
      content.appendChild(h2);
    }

    slide.appendChild(content);
    return slide;
  };

  TypeformWidget.prototype.createRatingSlide = function(content, step, primary) {
    var self = this;
    var ratingLabels = ['Poor', 'Fair', 'Good', 'Great', 'Excellent'];
    var emojiLabels = ['Terrible', 'Bad', 'Okay', 'Good', 'Amazing'];

    // Build rating UI using DOM methods to prevent XSS
    var h2 = document.createElement('h2');
    h2.style.cssText = 'font-size:28px;font-weight:600;margin:0 0 32px;';
    h2.textContent = step.title;
    content.appendChild(h2);

    var ratingContainer = document.createElement('div');
    ratingContainer.className = 'voc-rating-container';
    ratingContainer.style.cssText = 'display:flex;justify-content:center;gap:12px;flex-wrap:wrap;';

    if (step.ratingType === 'emoji') {
      var emojis = ['😡', '😕', '😐', '🙂', '😍'];
      emojis.forEach(function(emoji, i) {
        var btn = document.createElement('button');
        btn.className = 'voc-rating-btn';
        btn.dataset.value = i + 1;
        btn.dataset.label = emojiLabels[i];
        btn.style.cssText = 'font-size:48px;background:none;border:none;cursor:pointer;opacity:0.4;transition:all 0.2s;padding:8px;';
        btn.textContent = emoji;
        ratingContainer.appendChild(btn);
      });
    } else if (step.ratingType === 'numeric') {
      for (var n = 1; n <= 10; n++) {
        var btn = document.createElement('button');
        btn.className = 'voc-rating-btn';
        btn.dataset.value = n;
        btn.style.cssText = 'width:44px;height:44px;border:2px solid ' + KIRO.border + ';background:' + KIRO.background + ';color:' + KIRO.text + ';border-radius:8px;cursor:pointer;font-size:16px;font-weight:600;transition:all 0.2s;';
        btn.textContent = n;
        ratingContainer.appendChild(btn);
      }
    } else {
      for (var s = 1; s <= step.max; s++) {
        var btn = document.createElement('button');
        btn.className = 'voc-rating-btn';
        btn.dataset.value = s;
        btn.dataset.label = ratingLabels[s-1] || '';
        btn.style.cssText = 'font-size:40px;background:none;border:none;cursor:pointer;opacity:0.3;transition:all 0.2s;';
        btn.textContent = '★';
        ratingContainer.appendChild(btn);
      }
    }
    content.appendChild(ratingContainer);

    var hintEl = document.createElement('p');
    hintEl.className = 'voc-rating-hint';
    hintEl.style.cssText = 'margin-top:24px;font-size:14px;opacity:0.5;min-height:20px;';
    hintEl.textContent = 'Click to rate';
    content.appendChild(hintEl);

    // Highlight the buttons up to (stars) or at (emoji, numeric) `rating`; a falsy
    // rating resets them. Numeric buttons are recoloured only on a real selection
    // (`selecting`), and so is any rating type other than stars/emoji/numeric.
    function paintRatingButtons(rating, selecting) {
      content.querySelectorAll('.voc-rating-btn').forEach(function(b) {
        var v = parseInt(b.dataset.value);
        if (step.ratingType === 'stars') {
          b.style.opacity = v <= rating ? '1' : '0.3';
        } else if (step.ratingType === 'numeric') {
          if (!selecting) return;
          b.style.background = v === rating ? primary : KIRO.background;
          b.style.color = v === rating ? readableOn(primary) : KIRO.text;
          b.style.borderColor = v === rating ? primary : KIRO.border;
        } else if (selecting || step.ratingType === 'emoji') {
          b.style.opacity = v === rating ? '1' : '0.4';
          b.style.transform = v === rating ? 'scale(1.2)' : 'scale(1)';
        }
      });
    }

    content.querySelectorAll('.voc-rating-btn').forEach(function(btn) {
      btn.onmouseenter = function() {
        var label = this.dataset.label;
        if (label) hintEl.textContent = label;
        paintRatingButtons(parseInt(this.dataset.value), false);
      };

      btn.onmouseleave = function() {
        if (self.data.rating) {
          var selBtn = content.querySelector('.voc-rating-btn[data-value="' + self.data.rating + '"]');
          hintEl.textContent = selBtn ? (selBtn.dataset.label || 'Click to rate') : 'Click to rate';
        } else {
          hintEl.textContent = 'Click to rate';
        }
        paintRatingButtons(self.data.rating, false);
      };

      btn.onclick = function() {
        self.data.rating = parseInt(this.dataset.value);
        var label = this.dataset.label;
        if (label) hintEl.textContent = label;
        paintRatingButtons(self.data.rating, true);
        setTimeout(function() { self.next(); }, 300);
      };
    });
  };

  TypeformWidget.prototype.goToStep = function(index) {
    var slides = this.slidesContainer.querySelectorAll('[data-index]');
    var self = this;

    slides.forEach(function(slide, i) {
      if (i === index) {
        slide.style.opacity = '1';
        slide.style.transform = 'translateY(0)';
        slide.style.pointerEvents = 'auto';
        var input = slide.querySelector('.voc-input');
        if (input) setTimeout(function() { input.focus(); }, 100);
      } else {
        slide.style.opacity = '0';
        slide.style.transform = i < index ? 'translateY(-20px)' : 'translateY(20px)';
        slide.style.pointerEvents = 'none';
      }
    });

    this.currentStep = index;
    this.progressBar.style.width = ((index) / (this.steps.length - 1)) * 100 + '%';

    var step = this.steps[index];
    this.nav.style.display = (step.type === 'welcome' || step.type === 'thanks') ? 'none' : 'flex';
    this.prevBtn.style.opacity = index <= 1 ? '0.3' : '1';
    this.prevBtn.disabled = index <= 1;
  };

  TypeformWidget.prototype.next = function() {
    var step = this.steps[this.currentStep];

    // Validate current step before proceeding
    if (step.type === 'rating' && !this.data.rating) return;
    if (step.type === 'text' && !this.data.text.trim()) return;
    if (step.type === 'name' && !this.data.name.trim()) return;
    if (step.type === 'email' && !this.data.email.trim()) return;

    // Submit on second-to-last step
    if (this.currentStep === this.steps.length - 2) {
      this.submit();
      return;
    }

    if (this.currentStep < this.steps.length - 1) {
      this.goToStep(this.currentStep + 1);
    }
  };

  TypeformWidget.prototype.prev = function() {
    if (this.currentStep > 1) {
      this.goToStep(this.currentStep - 1);
    }
  };

  TypeformWidget.prototype.submit = function() {
    var self = this;
    if (this.isSubmitting) return;
    this.isSubmitting = true;

    var payload = {
      text: this.data.text,
      rating: this.data.rating,
      name: this.data.name || null,
      email: this.data.email || null,
      page_url: window.location.href
    };
    if (this.dimensions) payload.dimensions = this.dimensions;

    fetch(this.apiEndpoint + this.submitEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (result.success) {
        self.goToStep(self.steps.length - 1);
      } else {
        self.isSubmitting = false;
        alert(result.error || 'Failed to submit.');
      }
    })
    .catch(function() {
      self.isSubmitting = false;
      alert('Failed to submit.');
    });
  };

  // HTML escape helper
  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
})();
