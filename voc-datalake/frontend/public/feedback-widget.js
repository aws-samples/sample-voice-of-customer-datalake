/**
 * VoC Feedback Form Widget - Typeform-style
 * Conversational, one-question-at-a-time feedback collection
 */
(function() {
  'use strict';

  window.VoCFeedbackForm = {
    init: function(options) {
      var container = document.querySelector(options.container);
      if (!container) { console.error('VoCFeedbackForm: Container not found'); return; }

      var apiEndpoint = (options.apiEndpoint || '').replace(/\/+$/, '');
      if (!apiEndpoint) { console.error('VoCFeedbackForm: apiEndpoint required'); return; }

      fetch(apiEndpoint + '/feedback-form/config')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success && data.config && data.config.enabled) {
            new TypeformWidget(container, data.config, apiEndpoint);
          } else {
            container.innerHTML = '<p style="color:#666;text-align:center;padding:40px;">Feedback form unavailable.</p>';
          }
        })
        .catch(function() {
          container.innerHTML = '<p style="color:#666;text-align:center;padding:40px;">Failed to load form.</p>';
        });
    }
  };

  function TypeformWidget(container, config, apiEndpoint) {
    this.container = container;
    this.config = config;
    this.apiEndpoint = apiEndpoint;
    this.currentStep = 0;
    this.data = { rating: null, text: '', name: '', email: '' };
    this.steps = this.buildSteps();
    this.render();
  }

  TypeformWidget.prototype.buildSteps = function() {
    var steps = [];
    var c = this.config;
    
    // Welcome step
    steps.push({ type: 'welcome', title: c.title, subtitle: c.description });
    
    // Rating step (if enabled)
    if (c.rating_enabled) {
      steps.push({ type: 'rating', title: c.question, ratingType: c.rating_type, max: c.rating_max || 5 });
    }

    // Text feedback step
    steps.push({ type: 'text', title: 'Tell us more', placeholder: c.placeholder });
    
    // Name step (if enabled)
    if (c.collect_name) {
      steps.push({ type: 'name', title: "What's your name?", placeholder: 'Type your name...' });
    }
    
    // Email step (if enabled)
    if (c.collect_email) {
      steps.push({ type: 'email', title: "What's your email?", placeholder: 'name@example.com' });
    }
    
    // Thank you step
    steps.push({ type: 'thanks', title: c.success_message || 'Thank you!' });
    
    return steps;
  };

  TypeformWidget.prototype.render = function() {
    var t = this.config.theme || {};
    var primary = t.primary_color || '#3B82F6';
    var bg = t.background_color || '#FFFFFF';
    var text = t.text_color || '#1F2937';
    
    this.container.innerHTML = '';
    this.container.style.cssText = 'position:relative;min-height:400px;background:' + bg + ';color:' + text + 
      ';font-family:system-ui,-apple-system,sans-serif;overflow:hidden;';
    
    // Progress bar
    var progress = document.createElement('div');
    progress.className = 'voc-progress';
    progress.style.cssText = 'position:absolute;top:0;left:0;height:4px;background:' + primary + 
      ';transition:width 0.3s ease;width:0%;z-index:10;';
    this.container.appendChild(progress);
    this.progressBar = progress;
    
    // Slides container
    var slides = document.createElement('div');
    slides.className = 'voc-slides';
    slides.style.cssText = 'height:100%;min-height:400px;position:relative;';
    this.container.appendChild(slides);
    this.slidesContainer = slides;
    
    // Render all steps
    var self = this;
    this.steps.forEach(function(step, i) {
      var slide = self.createSlide(step, i);
      slides.appendChild(slide);
    });
    
    // Navigation
    var nav = document.createElement('div');
    nav.style.cssText = 'position:absolute;bottom:20px;right:20px;display:flex;gap:8px;';
    
    var prevBtn = document.createElement('button');
    prevBtn.innerHTML = '↑';
    prevBtn.style.cssText = 'width:40px;height:40px;border:1px solid #d1d5db;background:white;border-radius:4px;cursor:pointer;font-size:18px;';
    prevBtn.onclick = function() { self.prev(); };
    this.prevBtn = prevBtn;
    
    var nextBtn = document.createElement('button');
    nextBtn.innerHTML = '↓';
    nextBtn.style.cssText = 'width:40px;height:40px;border:none;background:' + primary + ';color:white;border-radius:4px;cursor:pointer;font-size:18px;';
    nextBtn.onclick = function() { self.next(); };
    this.nextBtn = nextBtn;
    
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    this.container.appendChild(nav);
    this.nav = nav;
    
    // Keyboard navigation
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { self.next(); }
      if (e.key === 'ArrowDown') { self.next(); }
      if (e.key === 'ArrowUp') { self.prev(); }
    });
    
    this.goToStep(0);
  };

  TypeformWidget.prototype.createSlide = function(step, index) {
    var self = this;
    var t = this.config.theme || {};
    var primary = t.primary_color || '#3B82F6';
    
    var slide = document.createElement('div');
    slide.className = 'voc-slide';
    slide.dataset.index = index;
    slide.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;' +
      'justify-content:center;align-items:center;padding:40px;box-sizing:border-box;opacity:0;transform:translateY(20px);' +
      'transition:opacity 0.4s ease,transform 0.4s ease;pointer-events:none;';
    
    var content = document.createElement('div');
    content.style.cssText = 'max-width:600px;width:100%;text-align:center;';
    
    if (step.type === 'welcome') {
      content.innerHTML = '<h1 style="font-size:32px;font-weight:700;margin:0 0 16px;">' + esc(step.title) + '</h1>' +
        '<p style="font-size:18px;opacity:0.7;margin:0 0 32px;">' + esc(step.subtitle) + '</p>' +
        '<button class="voc-start" style="background:' + primary + ';color:white;border:none;padding:16px 32px;' +
        'font-size:16px;border-radius:8px;cursor:pointer;">Start →</button>';
      content.querySelector('.voc-start').onclick = function() { self.next(); };
    }
    else if (step.type === 'rating') {
      var ratingHtml = '<h2 style="font-size:28px;font-weight:600;margin:0 0 32px;">' + esc(step.title) + '</h2><div class="voc-rating-options" style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">';
      
      if (step.ratingType === 'emoji') {
        var emojis = ['😡', '😕', '😐', '🙂', '😍'];
        emojis.forEach(function(e, i) {
          ratingHtml += '<button class="voc-rating-btn" data-value="' + (i+1) + '" style="font-size:48px;background:none;border:none;cursor:pointer;opacity:0.4;transition:all 0.2s;padding:8px;">' + e + '</button>';
        });
      } else if (step.ratingType === 'numeric') {
        for (var n = 1; n <= 10; n++) {
          ratingHtml += '<button class="voc-rating-btn" data-value="' + n + '" style="width:44px;height:44px;border:2px solid #d1d5db;background:white;border-radius:8px;cursor:pointer;font-size:16px;font-weight:600;transition:all 0.2s;">' + n + '</button>';
        }
      } else {
        for (var s = 1; s <= step.max; s++) {
          ratingHtml += '<button class="voc-rating-btn" data-value="' + s + '" style="font-size:40px;background:none;border:none;cursor:pointer;opacity:0.3;transition:all 0.2s;">★</button>';
        }
      }
      ratingHtml += '</div><p style="margin-top:24px;font-size:14px;opacity:0.5;">Press Enter or click to continue</p>';
      content.innerHTML = ratingHtml;
      
      content.querySelectorAll('.voc-rating-btn').forEach(function(btn) {
        btn.onclick = function() {
          self.data.rating = parseInt(this.dataset.value);
          content.querySelectorAll('.voc-rating-btn').forEach(function(b) {
            var v = parseInt(b.dataset.value);
            if (step.ratingType === 'stars') {
              b.style.opacity = v <= self.data.rating ? '1' : '0.3';
            } else if (step.ratingType === 'numeric') {
              b.style.background = v === self.data.rating ? primary : 'white';
              b.style.color = v === self.data.rating ? 'white' : 'inherit';
              b.style.borderColor = v === self.data.rating ? primary : '#d1d5db';
            } else {
              b.style.opacity = v === self.data.rating ? '1' : '0.4';
              b.style.transform = v === self.data.rating ? 'scale(1.2)' : 'scale(1)';
            }
          });
          setTimeout(function() { self.next(); }, 300);
        };
      });
    }
    else if (step.type === 'text') {
      content.innerHTML = '<h2 style="font-size:28px;font-weight:600;margin:0 0 24px;">' + esc(step.title) + '</h2>' +
        '<textarea class="voc-input" placeholder="' + esc(step.placeholder) + '" style="width:100%;min-height:150px;padding:16px;' +
        'font-size:18px;border:2px solid #e5e7eb;border-radius:12px;resize:none;font-family:inherit;box-sizing:border-box;' +
        'transition:border-color 0.2s;" onfocus="this.style.borderColor=\'' + primary + '\'" onblur="this.style.borderColor=\'#e5e7eb\'"></textarea>' +
        '<p style="margin-top:16px;font-size:14px;opacity:0.5;">Shift + Enter for new line, Enter to continue</p>';
      var ta = content.querySelector('.voc-input');
      ta.oninput = function() { self.data.text = this.value; };
      ta.onkeydown = function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); self.next(); } };
    }
    else if (step.type === 'name' || step.type === 'email') {
      content.innerHTML = '<h2 style="font-size:28px;font-weight:600;margin:0 0 24px;">' + esc(step.title) + '</h2>' +
        '<input type="' + (step.type === 'email' ? 'email' : 'text') + '" class="voc-input" placeholder="' + esc(step.placeholder) + '" ' +
        'style="width:100%;padding:16px;font-size:24px;border:none;border-bottom:2px solid #e5e7eb;text-align:center;' +
        'outline:none;background:transparent;transition:border-color 0.2s;" onfocus="this.style.borderColor=\'' + primary + '\'" ' +
        'onblur="this.style.borderColor=\'#e5e7eb\'">';
      var inp = content.querySelector('.voc-input');
      inp.oninput = function() { self.data[step.type] = this.value; };
      inp.onkeydown = function(e) { if (e.key === 'Enter') { self.next(); } };
    }
    else if (step.type === 'thanks') {
      content.innerHTML = '<div style="font-size:64px;margin-bottom:24px;">✓</div>' +
        '<h2 style="font-size:32px;font-weight:600;margin:0;">' + esc(step.title) + '</h2>';
    }
    
    slide.appendChild(content);
    return slide;
  };

  TypeformWidget.prototype.goToStep = function(index) {
    var slides = this.slidesContainer.querySelectorAll('.voc-slide');
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
    var progress = ((index) / (this.steps.length - 1)) * 100;
    this.progressBar.style.width = progress + '%';
    
    // Hide nav on welcome and thanks
    var step = this.steps[index];
    this.nav.style.display = (step.type === 'welcome' || step.type === 'thanks') ? 'none' : 'flex';
    this.prevBtn.style.opacity = index <= 1 ? '0.3' : '1';
    this.prevBtn.disabled = index <= 1;
  };

  TypeformWidget.prototype.next = function() {
    var step = this.steps[this.currentStep];
    
    // Validate text step
    if (step.type === 'text' && !this.data.text.trim()) {
      var ta = this.slidesContainer.querySelector('.voc-slide[data-index="' + this.currentStep + '"] .voc-input');
      if (ta) { ta.style.borderColor = '#ef4444'; setTimeout(function() { ta.style.borderColor = '#e5e7eb'; }, 1000); }
      return;
    }
    
    // Submit before thanks
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
    var payload = {
      text: this.data.text,
      rating: this.data.rating,
      name: this.data.name || null,
      email: this.data.email || null,
      page_url: window.location.href
    };
    
    fetch(this.apiEndpoint + '/feedback-form/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (result.success) {
        self.goToStep(self.steps.length - 1);
      } else {
        alert(result.error || 'Failed to submit. Please try again.');
      }
    })
    .catch(function() {
      alert('Failed to submit. Please try again.');
    });
  };

  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
})();
