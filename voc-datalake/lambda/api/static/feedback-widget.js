/**
 * VoC Feedback Form Widget: one question per screen, for a form of schema version 2 (questions, logic, hidden
 * fields, endings, languages; docs/feedback-forms.md). Self-contained and dependency-free: the app's own CloudFront
 * serves this file to customers' sites as a static asset, `/widget/feedback-widget.js` (frontend/widgetAssetPlugin.ts
 * builds it from this one source), the API inlines it into its own iframe page, and the editor's preview and its
 * pop-out window load it from the app's bundle.
 *
 * Usage:
 *   var form = VoCFeedbackForm.init({
 *     container: '#voc-feedback-form',          // a selector or an element
 *     apiEndpoint: 'https://api.example.com/v1',
 *     formId: 'abc123',
 *     configEndpoint: '/feedback-forms/abc123/config',   // optional
 *     submitEndpoint: '/feedback-forms/abc123/submit',   // optional: where responses go
 *     eventsEndpoint: '/feedback-forms/abc123/events',   // optional: where the funnel's beacons go
 *     language: 'pl',                           // optional: the respondent's language, if the form has it
 *     hidden: { user_id: 'u_1823' },            // optional: hidden-field values (undeclared ids are dropped)
 *     test: '<test token>',                     // optional: the form's test link token
 *     dimensions: { product: 'app' }            // optional: the deployment's embed dimensions (as before)
 *   });
 *   form.setHiddenFields({ screen: 'invoice_list' });  // or VoCFeedbackForm.setHiddenFields(...) for every form
 *
 * Isolation: the widget draws in an OPEN shadow root of the container (`container.shadowRoot`; the container's own
 * light DOM only where Shadow DOM is missing or the element cannot host one, a <form> for one). Inside it, its own
 * reset (`:host { all: initial }` and the rest, an adopted stylesheet where the browser has them, else a <style>),
 * then one inner root (`.voc-root`) holding the strip, the progress bar, the live region and the screen, so every
 * id, `aria-describedby` and `<label for>` resolves there. Every colour and inherited text property is also set
 * inline, so a page whose CSP blocks the stylesheet, or a browser without Shadow DOM, still gets the theme's form.
 * The checkboxes and radios are drawn by the widget (the real inputs stay, visually hidden, for the keyboard and
 * screen readers). Keys are handled in the shadow root, never on the page. The container's own styles stay the
 * page's: the widget sets only its `lang`.
 *
 * The theme (the config's `theme`; every field optional, so an old theme still works): `primary_color`,
 * `background_color` and `text_color` (the light palette; `#rgb` or `#rrggbb`, and a `#rrggbbaa` an old form holds
 * is drawn as its 6-digit colour), `border_radius` ('0px'–'39px'), `mode` ('light' by default, 'dark', or 'auto':
 * the respondent's prefers-color-scheme, followed as it changes), `dark` (the dark palette's three colours, the VoC
 * dark ones by default), `font` ('system' by default, 'serif', 'rounded', 'mono': system stacks, never a web font;
 * 'inherit' takes the page's font on a script embed only) and `text_size` ('default', or 'large': an 18 px body,
 * every size scaled alike). The widget holds the contrast rules of shared/form_theme.py: text under 3:1 on its
 * background is replaced by one that reads, the option edge is raised until it holds 3:1, and a primary under 3:1
 * gets its focus ring and selected edges drawn in the text colour.
 *
 * The editor's preview: `init({ container, language, preview: { config, seed, scheme } })` renders the given draft
 * and never fetches, submits or counts anything. `seed` (a number) makes Shuffle's order the same for the whole
 * preview session, Restart included; `scheme` ('light' | 'dark') shows that palette whatever the theme and the
 * device say. The returned object's update(config), goTo(target) (a question's id, 'welcome' or
 * 'end:<ending id>'), restart(), setLanguage(lang), setScheme('light' | 'dark' | null: the theme's own again) and
 * destroy() drive it, and so do `postMessage`s from this page's own origin
 * ({ type: 'voc-form-preview', action: 'config' | 'goTo' | 'restart' | 'language' | 'scheme', ... }).
 *
 * The API's own iframe page (…/feedback-forms/<id>/iframe) also reads its link: `hf_<id>=` hidden fields,
 * `lang=` and `test=`. A widget embedded on a customer's page never reads that page's address. A response says how
 * it was answered, `channel`: `link` (that page opened as it is), `iframe` (that page framed) or `script` (a script
 * embed), for the forms list's "Link · Website script · Embedded". Framed, that page
 * tells its parent how tall the form is, for the iframe snippet's resizer: `{ type: 'voc-form-height', height }`
 * (px, the height only) to `window.parent`, whenever it changes.
 *
 * The drop-off funnel (D6) takes two small beacons on its own route, `…/events` (`eventsEndpoint`;
 * navigator.sendBeacon, a text body), with its own throttle, so a beacon never spends the submit route's limit: one
 * `opened` once per page load per form, when the form is shown (the config read itself never counts or writes
 * anything), and, for a respondent who started and leaves without submitting, one `left` naming the furthest question
 * reached. The response carries the same `session`, so a respondent who comes back and submits is not a drop-off.
 * Never an answer, and nothing from the preview.
 */
(function() {
  'use strict';

  // The VoC palettes (frontend/src/styles/theme-palettes.css, AA-checked): primary, background, text. The light one
  // is a form's default (Kiro Light, docs/kiro-design-system.md), the dark one the default of a theme's `dark`
  // palette. A form's own theme colours always win; these apply only where the form leaves one unset.
  var KIRO = {
    primary: '#8e48ff',
    background: '#ffffff',
    text: '#19161d'
  };
  var KIRO_DARK = {
    primary: '#bd8fff',
    background: '#19161d',
    text: '#f2f1f4'
  };
  // The theme's `font`: system stacks only, so no web font is ever fetched (CSP and privacy). `inherit` ("Same as
  // your page") is the container's own font, for a script embed only (fontFor).
  var FONTS = {
    system: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    serif: 'ui-serif,Georgia,Cambria,"Times New Roman",serif',
    rounded: 'ui-rounded,"SF Pro Rounded","Arial Rounded MT",system-ui,sans-serif',
    mono: 'ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace'
  };
  // `text_size: 'large'`: an 18 px body instead of 16, every text size scaled by the same factor.
  var LARGE_SCALE = 18 / 16;
  // The test and preview strips: the same in every theme (12:1 and 14:1).
  var STRIP_TEXT = '#19161d';
  var STRIP_TEST = '#f5d565';
  var STRIP_PREVIEW = '#e4e4e7';

  /** `#rrggbb` as its three 0–255 channels. */
  function channelsOf(hex) {
    return [1, 3, 5].map(function(i) { return parseInt(hex.slice(i, i + 2), 16); });
  }

  /** WCAG relative luminance of a theme colour (hexColour), or null for anything else. */
  function luminance(colour) {
    var hex = hexColour(colour);
    if (!hex) return null;
    var linear = channelsOf(hex).map(function(value) {
      var channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  function contrast(a, b) {
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** The WCAG contrast of two hex colours (1 when either is not one). */
  function contrastOf(a, b) {
    var la = luminance(a), lb = luminance(b);
    return la === null || lb === null ? 1 : contrast(la, lb);
  }

  /** `#rgb`, `#rrggbb` or `#rrggbbaa` only (as shared/form_theme.py HEX_COLOR): the theme is concatenated
   * into style.cssText on the customer's own page, so anything else falls back to the default (FE-2). */
  var HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

  /** A theme colour as `#rrggbb`, or null. `#rgb` is expanded; a `#rrggbbaa` an old form may hold is drawn as its
   * 6-digit colour (its alpha dropped), so what is drawn is what the contrast checks measured. */
  function hexColour(value) {
    if (typeof value !== 'string' || !HEX_COLOR.test(value)) return null;
    var hex = value.slice(1).toLowerCase();
    if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
    return '#' + hex.slice(0, 6);
  }

  function safeColour(value, fallback) {
    return hexColour(value) || fallback;
  }

  /**
   * The text colour for a label ON `fill` (the start/next/selected buttons): white or Kiro strong text,
   * whichever contrasts more. Keeps a customer's brand colour as the fill while the label stays readable.
   * Anything that is not a hex colour keeps white.
   */
  function readableOn(fill) {
    var l = luminance(fill);
    if (l === null) return '#ffffff';
    return contrast(l, 1) >= contrast(l, luminance(KIRO.text)) ? '#ffffff' : KIRO.text;
  }

  /** The widget's last line of defence for text: `text` on `bg`, unless it is under 3:1 there, when it is
   * readableOn(bg). The editor and the server refuse to publish such a form; this keeps an old one legible. */
  function safeContrast(text, bg) {
    return contrastOf(text, bg) >= 3 ? text : readableOn(bg);
  }

  /** A checked hex colour at `alpha`, as rgba() (borders and tints that follow the theme). */
  function rgba(hex, alpha) {
    var h = hexColour(hex);
    if (!h) return hex;
    // Not `c`: that name means the version 1 config in this file (V1Config.migrate).
    var rgb = channelsOf(h);
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
  }

  /** `fg` at `alpha` over `bg`, as the browser blends it: one `#rrggbb`. */
  function blend(fg, bg, alpha) {
    var f = channelsOf(fg), b = channelsOf(bg);
    return '#' + [0, 1, 2].map(function(i) {
      var value = Math.round(f[i] * alpha + b[i] * (1 - alpha));
      return (value < 16 ? '0' : '') + value.toString(16);
    }).join('');
  }

  /** The least alpha of `fg` over `bg`, from `start` up in steps of 0.05, at which it reaches `ratio` against `bg`
   * (1 at most: an opaque `fg`). */
  function alphaFor(fg, bg, start, ratio) {
    for (var alpha = start; alpha < 1; alpha = Math.round((alpha + 0.05) * 100) / 100) {
      if (contrastOf(blend(fg, bg, alpha), bg) >= ratio) return alpha;
    }
    return 1;
  }

  // The widget's own words, in the app's nine locales (frontend/public/locales). The form's own copy (its
  // welcome, questions, options and endings) is the author's, in the form's languages, and never translated
  // here. `{n}`, `{m}`, `{min}` and `{max}` are filled by fill(). `tellUsMore`, `rateUs` and `contactTitle` are
  // the headlines the v1 migration gives a step whose form had none (lambda/shared/forms_v2.py does the same).
  var STRINGS = {
    en: {
      start: 'Start', next: 'Next', previous: 'Back', submit: 'Submit', sending: 'Sending…',
      required: 'Required', optional: 'Optional',
      chooseAnswer: 'Choose an answer to continue.', typeAnswer: 'Type an answer to continue.',
      chooseAll: 'Choose all that apply', chooseUpTo: 'Choose up to {n}', chooseAtLeast: 'Choose at least {n}',
      chooseBetween: 'Choose {min} to {max}', chooseExactly: 'Choose {n}',
      tooMany: 'You can choose up to {n}.', tooFew: 'Choose at least {n} to continue.',
      other: 'Other', otherPlaceholder: 'Please specify', otherRequired: 'Type your answer for Other.',
      none: 'None of these', choose: 'Choose…', selected: '{n} selected', search: 'Search', noMatches: 'No matches',
      textPlaceholder: 'Type your answer here…', enterHint: 'Press Enter ↵',
      ctrlEnterHint: 'Ctrl+Enter to continue (⌘+Enter on a Mac)', charCount: '{n} / {max}',
      invalidEmail: 'Enter a valid email address.', invalidNumber: 'Enter a number.',
      invalidPhone: 'Enter a valid phone number.', invalidUrl: 'Enter a valid web address.',
      consentRequired: 'Tick the box to continue.',
      name: 'Name', email: 'Email', phone: 'Phone', company: 'Company',
      outOf: '{n} of {max}',
      faces3: ['Bad', 'Okay', 'Good'], faces4: ['Very bad', 'Bad', 'Good', 'Very good'],
      faces5: ['Very bad', 'Bad', 'Okay', 'Good', 'Very good'],
      progress: 'Question {n} of {m}', newTab: '(opens in a new tab)', thanks: 'Thank you!',
      pageTitle: 'Feedback form', unavailable: 'Feedback form unavailable.',
      loadFailed: "Couldn't load this form. Check your connection and reload the page.",
      submitFailed: "Couldn't send your answers. Check your connection and try again.", retry: 'Try again',
      refused: "Some answers couldn't be accepted.",
      formChanged: 'This form was updated while you were answering. Reload to answer the latest version.',
      reload: 'Reload', testInvalid: 'This test link no longer works.',
      testKeep: "TEST · Responses aren't counted", testDrop: 'TEST · Nothing is saved',
      preview: 'Preview · Nothing is sent', previewDone: 'Preview · nothing was sent',
      tellUsMore: 'Tell us more', rateUs: 'How was your experience?', contactTitle: 'How can we reach you?'
    },
    es: {
      start: 'Comenzar', next: 'Siguiente', previous: 'Atrás', submit: 'Enviar', sending: 'Enviando…',
      required: 'Obligatoria', optional: 'Opcional',
      chooseAnswer: 'Elija una respuesta para continuar.', typeAnswer: 'Escriba una respuesta para continuar.',
      chooseAll: 'Elija todas las que correspondan', chooseUpTo: 'Elija hasta {n}', chooseAtLeast: 'Elija al menos {n}',
      chooseBetween: 'Elija de {min} a {max}', chooseExactly: 'Elija {n}',
      tooMany: 'Puede elegir hasta {n}.', tooFew: 'Elija al menos {n} para continuar.',
      other: 'Otro', otherPlaceholder: 'Especifique', otherRequired: 'Escriba su respuesta para «Otro».',
      none: 'Ninguna de estas', choose: 'Elegir…', selected: '{n} seleccionadas', search: 'Buscar',
      noMatches: 'Sin resultados',
      textPlaceholder: 'Escriba aquí su respuesta…', enterHint: 'Pulse Intro ↵',
      ctrlEnterHint: 'Ctrl+Intro para continuar (⌘+Intro en Mac)', charCount: '{n} / {max}',
      invalidEmail: 'Introduzca una dirección de correo electrónico válida.', invalidNumber: 'Introduzca un número.',
      invalidPhone: 'Introduzca un número de teléfono válido.', invalidUrl: 'Introduzca una dirección web válida.',
      consentRequired: 'Marque la casilla para continuar.',
      name: 'Nombre', email: 'Correo electrónico', phone: 'Teléfono', company: 'Empresa',
      outOf: '{n} de {max}',
      faces3: ['Mal', 'Normal', 'Bien'], faces4: ['Muy mal', 'Mal', 'Bien', 'Muy bien'],
      faces5: ['Muy mal', 'Mal', 'Normal', 'Bien', 'Muy bien'],
      progress: 'Pregunta {n} de {m}', newTab: '(se abre en una pestaña nueva)', thanks: '¡Gracias!',
      pageTitle: 'Formulario de opinión', unavailable: 'Formulario de opinión no disponible.',
      loadFailed: 'No se pudo cargar este formulario. Compruebe su conexión y vuelva a cargar la página.',
      submitFailed: 'No se pudieron enviar sus respuestas. Compruebe su conexión e inténtelo de nuevo.',
      retry: 'Reintentar', refused: 'Algunas respuestas no se pudieron aceptar.',
      formChanged: 'Este formulario se actualizó mientras respondía. Vuelva a cargarlo para responder a la versión más reciente.',
      reload: 'Volver a cargar', testInvalid: 'Este enlace de prueba ya no funciona.',
      testKeep: 'TEST · Las respuestas no se cuentan', testDrop: 'TEST · No se guarda nada',
      preview: 'Vista previa · No se envía nada', previewDone: 'Vista previa · no se envió nada',
      tellUsMore: 'Cuéntenos más', rateUs: '¿Cómo fue su experiencia?', contactTitle: '¿Cómo podemos contactarle?'
    },
    fr: {
      start: 'Commencer', next: 'Suivant', previous: 'Retour', submit: 'Envoyer', sending: 'Envoi…',
      required: 'Obligatoire', optional: 'Facultatif',
      chooseAnswer: 'Choisissez une réponse pour continuer.', typeAnswer: 'Saisissez une réponse pour continuer.',
      chooseAll: 'Choisissez toutes les réponses qui s’appliquent', chooseUpTo: 'Choisissez-en jusqu’à {n}',
      chooseAtLeast: 'Choisissez-en au moins {n}', chooseBetween: 'Choisissez-en de {min} à {max}',
      chooseExactly: 'Choisissez-en {n}',
      tooMany: 'Vous pouvez en choisir jusqu’à {n}.', tooFew: 'Choisissez-en au moins {n} pour continuer.',
      other: 'Autre', otherPlaceholder: 'Précisez',
      otherRequired: 'Saisissez votre réponse pour « Autre ».',
      none: 'Aucune de ces réponses', choose: 'Choisir…', selected: 'Sélection : {n}', search: 'Rechercher',
      noMatches: 'Aucun résultat',
      textPlaceholder: 'Saisissez votre réponse ici…', enterHint: 'Appuyez sur Entrée ↵',
      ctrlEnterHint: 'Ctrl+Entrée pour continuer (⌘+Entrée sur Mac)', charCount: '{n} / {max}',
      invalidEmail: 'Saisissez une adresse e-mail valide.', invalidNumber: 'Saisissez un nombre.',
      invalidPhone: 'Saisissez un numéro de téléphone valide.', invalidUrl: 'Saisissez une adresse web valide.',
      consentRequired: 'Cochez la case pour continuer.',
      name: 'Nom', email: 'E-mail', phone: 'Téléphone', company: 'Entreprise',
      outOf: '{n} sur {max}',
      faces3: ['Mauvais', 'Moyen', 'Bien'], faces4: ['Très mauvais', 'Mauvais', 'Bien', 'Très bien'],
      faces5: ['Très mauvais', 'Mauvais', 'Moyen', 'Bien', 'Très bien'],
      progress: 'Question {n} sur {m}', newTab: '(s’ouvre dans un nouvel onglet)', thanks: 'Merci !',
      pageTitle: 'Formulaire d’avis', unavailable: "Formulaire d'avis indisponible.",
      loadFailed: 'Impossible de charger ce formulaire. Vérifiez votre connexion et rechargez la page.',
      submitFailed: 'Impossible d’envoyer vos réponses. Vérifiez votre connexion et réessayez.',
      retry: 'Réessayer', refused: 'Certaines réponses n’ont pas pu être acceptées.',
      formChanged: 'Ce formulaire a été modifié pendant que vous répondiez. Rechargez-le pour répondre à la dernière version.',
      reload: 'Recharger', testInvalid: 'Ce lien de test ne fonctionne plus.',
      testKeep: 'TEST · Les réponses ne sont pas comptées', testDrop: 'TEST · Rien n’est enregistré',
      preview: 'Aperçu · Rien n’est envoyé', previewDone: 'Aperçu · rien n’a été envoyé',
      tellUsMore: 'Dites-nous-en plus', rateUs: 'Comment s’est passée votre expérience ?',
      contactTitle: 'Comment pouvons-nous vous joindre ?'
    },
    de: {
      start: 'Starten', next: 'Weiter', previous: 'Zurück', submit: 'Senden', sending: 'Wird gesendet…',
      required: 'Pflichtfeld', optional: 'Freiwillig',
      chooseAnswer: 'Wählen Sie eine Antwort, um fortzufahren.',
      typeAnswer: 'Geben Sie eine Antwort ein, um fortzufahren.',
      chooseAll: 'Wählen Sie alle zutreffenden aus', chooseUpTo: 'Wählen Sie bis zu {n}',
      chooseAtLeast: 'Wählen Sie mindestens {n}', chooseBetween: 'Wählen Sie {min} bis {max}',
      chooseExactly: 'Wählen Sie {n}',
      tooMany: 'Sie können bis zu {n} auswählen.', tooFew: 'Wählen Sie mindestens {n}, um fortzufahren.',
      other: 'Sonstiges', otherPlaceholder: 'Bitte angeben',
      otherRequired: 'Geben Sie Ihre Antwort für „Sonstiges“ ein.',
      none: 'Nichts davon', choose: 'Auswählen…', selected: '{n} ausgewählt', search: 'Suchen',
      noMatches: 'Keine Treffer',
      textPlaceholder: 'Geben Sie hier Ihre Antwort ein…', enterHint: 'Eingabetaste drücken ↵',
      ctrlEnterHint: 'Strg+Eingabe zum Fortfahren (⌘+Eingabe auf dem Mac)', charCount: '{n} / {max}',
      invalidEmail: 'Geben Sie eine gültige E-Mail-Adresse ein.', invalidNumber: 'Geben Sie eine Zahl ein.',
      invalidPhone: 'Geben Sie eine gültige Telefonnummer ein.', invalidUrl: 'Geben Sie eine gültige Webadresse ein.',
      consentRequired: 'Setzen Sie das Häkchen, um fortzufahren.',
      name: 'Name', email: 'E-Mail', phone: 'Telefon', company: 'Unternehmen',
      outOf: '{n} von {max}',
      faces3: ['Schlecht', 'Mittel', 'Gut'], faces4: ['Sehr schlecht', 'Schlecht', 'Gut', 'Sehr gut'],
      faces5: ['Sehr schlecht', 'Schlecht', 'Mittel', 'Gut', 'Sehr gut'],
      progress: 'Frage {n} von {m}', newTab: '(öffnet in einem neuen Tab)', thanks: 'Vielen Dank!',
      pageTitle: 'Feedback-Formular', unavailable: 'Feedback-Formular nicht verfügbar.',
      loadFailed: 'Das Formular konnte nicht geladen werden. Prüfen Sie Ihre Verbindung und laden Sie die Seite neu.',
      submitFailed: 'Ihre Antworten konnten nicht gesendet werden. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
      retry: 'Erneut versuchen', refused: 'Einige Antworten konnten nicht angenommen werden.',
      formChanged: 'Dieses Formular wurde geändert, während Sie es ausgefüllt haben. Laden Sie es neu, um die aktuelle Version zu beantworten.',
      reload: 'Neu laden', testInvalid: 'Dieser Testlink funktioniert nicht mehr.',
      testKeep: 'TEST · Antworten werden nicht gezählt', testDrop: 'TEST · Nichts wird gespeichert',
      preview: 'Vorschau · Nichts wird gesendet', previewDone: 'Vorschau · nichts wurde gesendet',
      tellUsMore: 'Erzählen Sie uns mehr', rateUs: 'Wie war Ihre Erfahrung?',
      contactTitle: 'Wie können wir Sie erreichen?'
    },
    pt: {
      start: 'Começar', next: 'Próximo', previous: 'Voltar', submit: 'Enviar', sending: 'Enviando…',
      required: 'Obrigatória', optional: 'Opcional',
      chooseAnswer: 'Escolha uma resposta para continuar.', typeAnswer: 'Digite uma resposta para continuar.',
      chooseAll: 'Escolha todas as que se aplicam', chooseUpTo: 'Escolha até {n}',
      chooseAtLeast: 'Escolha pelo menos {n}', chooseBetween: 'Escolha de {min} a {max}', chooseExactly: 'Escolha {n}',
      tooMany: 'Você pode escolher até {n}.', tooFew: 'Escolha pelo menos {n} para continuar.',
      other: 'Outro', otherPlaceholder: 'Especifique', otherRequired: 'Digite sua resposta para “Outro”.',
      none: 'Nenhuma destas', choose: 'Escolher…', selected: '{n} selecionadas', search: 'Pesquisar',
      noMatches: 'Nenhum resultado',
      textPlaceholder: 'Digite sua resposta aqui…', enterHint: 'Pressione Enter ↵',
      ctrlEnterHint: 'Ctrl+Enter para continuar (⌘+Enter no Mac)', charCount: '{n} / {max}',
      invalidEmail: 'Informe um endereço de e-mail válido.', invalidNumber: 'Informe um número.',
      invalidPhone: 'Informe um número de telefone válido.', invalidUrl: 'Informe um endereço web válido.',
      consentRequired: 'Marque a caixa para continuar.',
      name: 'Nome', email: 'E-mail', phone: 'Telefone', company: 'Empresa',
      outOf: '{n} de {max}',
      faces3: ['Ruim', 'Razoável', 'Bom'], faces4: ['Muito ruim', 'Ruim', 'Bom', 'Muito bom'],
      faces5: ['Muito ruim', 'Ruim', 'Razoável', 'Bom', 'Muito bom'],
      progress: 'Pergunta {n} de {m}', newTab: '(abre em uma nova guia)', thanks: 'Obrigado!',
      pageTitle: 'Formulário de feedback', unavailable: 'Formulário de feedback indisponível.',
      loadFailed: 'Não foi possível carregar este formulário. Verifique sua conexão e recarregue a página.',
      submitFailed: 'Não foi possível enviar suas respostas. Verifique sua conexão e tente novamente.',
      retry: 'Tentar novamente', refused: 'Algumas respostas não puderam ser aceitas.',
      formChanged: 'Este formulário foi atualizado enquanto você respondia. Recarregue para responder à versão mais recente.',
      reload: 'Recarregar', testInvalid: 'Este link de teste não funciona mais.',
      testKeep: 'TEST · As respostas não são contadas', testDrop: 'TEST · Nada é salvo',
      preview: 'Prévia · Nada é enviado', previewDone: 'Prévia · nada foi enviado',
      tellUsMore: 'Conte-nos mais', rateUs: 'Como foi sua experiência?',
      contactTitle: 'Como podemos entrar em contato com você?'
    },
    ja: {
      start: '開始', next: '次へ', previous: '戻る', submit: '送信', sending: '送信中…',
      required: '必須', optional: '任意',
      chooseAnswer: '続けるには回答を選択してください。', typeAnswer: '続けるには回答を入力してください。',
      chooseAll: '当てはまるものをすべて選択', chooseUpTo: '{n} 個まで選択', chooseAtLeast: '{n} 個以上選択',
      chooseBetween: '{min}～{max} 個を選択', chooseExactly: '{n} 個を選択',
      tooMany: '選択できるのは {n} 個までです。', tooFew: '続けるには {n} 個以上選択してください。',
      other: 'その他', otherPlaceholder: '具体的に入力してください', otherRequired: '「その他」の回答を入力してください。',
      none: 'どれも当てはまらない', choose: '選択…', selected: '{n} 個選択中', search: '検索',
      noMatches: '一致するものはありません',
      textPlaceholder: 'ここに回答を入力…', enterHint: 'Enter キーを押す ↵',
      ctrlEnterHint: 'Ctrl+Enter で続行（Mac では ⌘+Enter）', charCount: '{n} / {max}',
      invalidEmail: '有効なメールアドレスを入力してください。', invalidNumber: '数値を入力してください。',
      invalidPhone: '有効な電話番号を入力してください。', invalidUrl: '有効な Web アドレスを入力してください。',
      consentRequired: '続けるにはチェックボックスをオンにしてください。',
      name: '氏名', email: 'メールアドレス', phone: '電話番号', company: '会社名',
      outOf: '{max} 段階中 {n}',
      faces3: ['悪い', '普通', '良い'], faces4: ['とても悪い', '悪い', '良い', 'とても良い'],
      faces5: ['とても悪い', '悪い', '普通', '良い', 'とても良い'],
      progress: '質問 {n}/{m}', newTab: '（新しいタブで開きます）', thanks: 'ありがとうございました！',
      pageTitle: 'フィードバックフォーム', unavailable: 'フィードバックフォームは利用できません。',
      loadFailed: 'フォームを読み込めませんでした。接続を確認して、ページを再読み込みしてください。',
      submitFailed: '回答を送信できませんでした。接続を確認して、もう一度お試しください。',
      retry: '再試行', refused: '一部の回答を受け付けられませんでした。',
      formChanged: '回答中にこのフォームが更新されました。再読み込みして最新版に回答してください。',
      reload: '再読み込み', testInvalid: 'このテストリンクは無効になりました。',
      testKeep: 'TEST · 回答はカウントされません', testDrop: 'TEST · 何も保存されません',
      preview: 'プレビュー · 何も送信されません', previewDone: 'プレビュー · 何も送信されませんでした',
      tellUsMore: '詳しく教えてください', rateUs: 'ご利用の感想はいかがでしたか？', contactTitle: 'ご連絡先を教えてください'
    },
    zh: {
      start: '开始', next: '下一步', previous: '返回', submit: '提交', sending: '正在提交…',
      required: '必填', optional: '选填',
      chooseAnswer: '请选择一个答案以继续。', typeAnswer: '请输入答案以继续。',
      chooseAll: '选择所有适用项', chooseUpTo: '最多选择 {n} 项', chooseAtLeast: '至少选择 {n} 项',
      chooseBetween: '选择 {min} 到 {max} 项', chooseExactly: '选择 {n} 项',
      tooMany: '最多只能选择 {n} 项。', tooFew: '请至少选择 {n} 项以继续。',
      other: '其他', otherPlaceholder: '请具体说明', otherRequired: '请填写“其他”的答案。',
      none: '以上都不是', choose: '请选择…', selected: '已选择 {n} 项', search: '搜索', noMatches: '无匹配结果',
      textPlaceholder: '在此输入您的答案…', enterHint: '按 Enter 键 ↵',
      ctrlEnterHint: '按 Ctrl+Enter 继续（Mac 上按 ⌘+Enter）', charCount: '{n} / {max}',
      invalidEmail: '请输入有效的电子邮箱地址。', invalidNumber: '请输入数字。',
      invalidPhone: '请输入有效的电话号码。', invalidUrl: '请输入有效的网址。',
      consentRequired: '请勾选此框以继续。',
      name: '姓名', email: '电子邮箱', phone: '电话', company: '公司',
      outOf: '{max} 分中的 {n} 分',
      faces3: ['差', '一般', '好'], faces4: ['很差', '差', '好', '很好'], faces5: ['很差', '差', '一般', '好', '很好'],
      progress: '第 {n} 题，共 {m} 题', newTab: '（在新标签页中打开）', thanks: '谢谢！',
      pageTitle: '反馈表单', unavailable: '反馈表单不可用。',
      loadFailed: '无法加载此表单。请检查网络连接并刷新页面。',
      submitFailed: '无法提交您的答案。请检查网络连接后重试。',
      retry: '重试', refused: '部分答案未被接受。',
      formChanged: '您填写期间此表单已更新。请刷新以回答最新版本。',
      reload: '刷新', testInvalid: '此测试链接已失效。',
      testKeep: 'TEST · 回答不计入统计', testDrop: 'TEST · 不保存任何内容',
      preview: '预览 · 不会发送任何内容', previewDone: '预览 · 未发送任何内容',
      tellUsMore: '请告诉我们更多', rateUs: '您的体验如何？', contactTitle: '我们如何联系您？'
    },
    ko: {
      start: '시작', next: '다음', previous: '이전', submit: '제출', sending: '보내는 중…',
      required: '필수', optional: '선택',
      chooseAnswer: '계속하려면 답을 선택하세요.', typeAnswer: '계속하려면 답을 입력하세요.',
      chooseAll: '해당하는 항목을 모두 선택하세요', chooseUpTo: '최대 {n}개 선택', chooseAtLeast: '{n}개 이상 선택',
      chooseBetween: '{min}~{max}개 선택', chooseExactly: '{n}개 선택',
      tooMany: '최대 {n}개까지 선택할 수 있습니다.', tooFew: '계속하려면 {n}개 이상 선택하세요.',
      other: '기타', otherPlaceholder: '직접 입력', otherRequired: '"기타"에 답을 입력하세요.',
      none: '해당 없음', choose: '선택…', selected: '{n}개 선택됨', search: '검색', noMatches: '일치하는 항목 없음',
      textPlaceholder: '여기에 답을 입력하세요…', enterHint: 'Enter 키 누르기 ↵',
      ctrlEnterHint: 'Ctrl+Enter로 계속(Mac에서는 ⌘+Enter)', charCount: '{n} / {max}',
      invalidEmail: '올바른 이메일 주소를 입력하세요.', invalidNumber: '숫자를 입력하세요.',
      invalidPhone: '올바른 전화번호를 입력하세요.', invalidUrl: '올바른 웹 주소를 입력하세요.',
      consentRequired: '계속하려면 확인란을 선택하세요.',
      name: '이름', email: '이메일', phone: '전화번호', company: '회사',
      outOf: '{max}점 중 {n}점',
      faces3: ['나쁨', '보통', '좋음'], faces4: ['매우 나쁨', '나쁨', '좋음', '매우 좋음'],
      faces5: ['매우 나쁨', '나쁨', '보통', '좋음', '매우 좋음'],
      progress: '질문 {n}/{m}', newTab: '(새 탭에서 열림)', thanks: '감사합니다!',
      pageTitle: '피드백 양식', unavailable: '피드백 양식을 사용할 수 없습니다.',
      loadFailed: '이 양식을 불러오지 못했습니다. 연결을 확인하고 페이지를 새로 고치세요.',
      submitFailed: '답변을 보내지 못했습니다. 연결을 확인하고 다시 시도하세요.',
      retry: '다시 시도', refused: '일부 답변을 받을 수 없습니다.',
      formChanged: '답하는 동안 이 양식이 변경되었습니다. 새로 고쳐 최신 버전에 답하세요.',
      reload: '새로 고침', testInvalid: '이 테스트 링크는 더 이상 작동하지 않습니다.',
      testKeep: 'TEST · 응답이 집계되지 않음', testDrop: 'TEST · 아무것도 저장되지 않음',
      preview: '미리보기 · 아무것도 전송되지 않음', previewDone: '미리보기 · 아무것도 전송되지 않았음',
      tellUsMore: '더 자세히 알려 주세요', rateUs: '경험은 어떠셨나요?', contactTitle: '연락처를 알려 주세요'
    },
    pl: {
      start: 'Rozpocznij', next: 'Dalej', previous: 'Wstecz', submit: 'Wyślij', sending: 'Wysyłanie…',
      required: 'Wymagane', optional: 'Opcjonalne',
      chooseAnswer: 'Wybierz odpowiedź, aby przejść dalej.', typeAnswer: 'Wpisz odpowiedź, aby przejść dalej.',
      chooseAll: 'Zaznacz wszystkie pasujące', chooseUpTo: 'Wybierz maksymalnie {n}',
      chooseAtLeast: 'Wybierz co najmniej {n}', chooseBetween: 'Wybierz od {min} do {max}', chooseExactly: 'Wybierz {n}',
      tooMany: 'Możesz wybrać maksymalnie {n}.', tooFew: 'Wybierz co najmniej {n}, aby przejść dalej.',
      other: 'Inne', otherPlaceholder: 'Doprecyzuj', otherRequired: 'Wpisz odpowiedź w polu „Inne”.',
      none: 'Żadne z powyższych', choose: 'Wybierz…', selected: 'Wybrano: {n}', search: 'Szukaj',
      noMatches: 'Brak wyników',
      textPlaceholder: 'Wpisz tutaj odpowiedź…', enterHint: 'Naciśnij Enter ↵',
      ctrlEnterHint: 'Ctrl+Enter, aby przejść dalej (⌘+Enter na Macu)', charCount: '{n} / {max}',
      invalidEmail: 'Podaj poprawny adres e-mail.', invalidNumber: 'Podaj liczbę.',
      invalidPhone: 'Podaj poprawny numer telefonu.', invalidUrl: 'Podaj poprawny adres strony.',
      consentRequired: 'Zaznacz pole, aby przejść dalej.',
      name: 'Imię i nazwisko', email: 'E-mail', phone: 'Telefon', company: 'Firma',
      outOf: '{n} z {max}',
      faces3: ['Źle', 'Średnio', 'Dobrze'], faces4: ['Bardzo źle', 'Źle', 'Dobrze', 'Bardzo dobrze'],
      faces5: ['Bardzo źle', 'Źle', 'Średnio', 'Dobrze', 'Bardzo dobrze'],
      progress: 'Pytanie {n} z {m}', newTab: '(otwiera się w nowej karcie)', thanks: 'Dziękujemy!',
      pageTitle: 'Formularz opinii', unavailable: 'Formularz jest niedostępny.',
      loadFailed: 'Nie udało się wczytać formularza. Sprawdź połączenie i odśwież stronę.',
      submitFailed: 'Nie udało się wysłać odpowiedzi. Sprawdź połączenie i spróbuj ponownie.',
      retry: 'Spróbuj ponownie', refused: 'Nie wszystkie odpowiedzi zostały przyjęte.',
      formChanged: 'Formularz zmienił się w trakcie wypełniania. Odśwież stronę, aby odpowiedzieć na najnowszą wersję.',
      reload: 'Odśwież', testInvalid: 'Ten link testowy już nie działa.',
      testKeep: 'TEST · Odpowiedzi nie są liczone', testDrop: 'TEST · Nic nie jest zapisywane',
      preview: 'Podgląd · Nic nie jest wysyłane', previewDone: 'Podgląd · nic nie zostało wysłane',
      tellUsMore: 'Powiedz nam więcej', rateUs: 'Jak oceniasz swoje doświadczenie?',
      contactTitle: 'Jak możemy się z Tobą skontaktować?'
    }
  };

  // ── Small helpers ─────────────────────────────────────────────────────────────────────────────────────────

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function own(obj, key) {
    return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** A string with something besides whitespace in it. */
  function nonBlank(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  function isInt(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  /** `code` ('pl', 'pl-PL', 'de_AT') as one of the STRINGS locales, or null. */
  function knownLocale(code) {
    var primary = (typeof code === 'string' ? code : '').trim().toLowerCase().split(/[-_]/)[0];
    return Object.prototype.hasOwnProperty.call(STRINGS, primary) ? primary : null;
  }

  /** The browser's languages as STRINGS locales, in its order of preference. */
  function browserLocales() {
    var nav = window.navigator || {};
    var raw = Array.isArray(nav.languages) && nav.languages.length ? nav.languages : [nav.language];
    var out = [];
    raw.forEach(function(code) {
      var locale = knownLocale(code);
      if (locale && out.indexOf(locale) < 0) out.push(locale);
    });
    return out;
  }

  /** `template` with each `{key}` of `values` filled in. */
  function fill(template, values) {
    return String(template).replace(/\{(n|m|min|max)\}/g, function(whole, key) {
      return own(values, key) ? String(values[key]) : whole;
    });
  }

  /** Whether the media query matches (false where matchMedia is missing). */
  function media(query) {
    try {
      return !!(window.matchMedia && window.matchMedia(query).matches);
    } catch (e) {
      return false;
    }
  }

  /** An element with inline styles and, optionally, its text (always textContent, never markup). */
  function el(tag, cssText, text) {
    var node = document.createElement(tag);
    if (cssText) node.style.cssText = cssText;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** Visually hidden, still read by screen readers (inline, so it holds where a page's CSP blocks <style>). */
  var SR_ONLY = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);' +
    'white-space:nowrap;border:0;';

  /**
   * `value` as an absolute https URL to open (its normalized href), or null: https only, a host, no user name or
   * password, no spaces or control characters, at most 2048 characters (shared/forms_v2.py https_url). The only
   * way a link from the config reaches the page.
   */
  function safeHttpsUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) return null;
    if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch (e) {
      return null;
    }
  }

  // The server's own checks (shared/forms_v2_responses.py), so a respondent hears about a typo before Submit.
  var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var PHONE = /^\+?[0-9 ().\-\/]{3,40}$/;
  var NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  function validWebAddress(text) {
    if (/\s/.test(text)) return false;
    try {
      var url = new URL(text);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.host;
    } catch (e) {
      return false;
    }
  }

  // ── The form: the config as version 2, whatever the server sent ──────────────────────────────────────────

  var TYPES = ['open_text', 'single_select', 'multi_select', 'rating', 'nps', 'csat', 'ces', 'statement', 'consent',
    'contact_info'];
  var SCALE_TYPES = ['rating', 'nps', 'csat', 'ces'];
  var CONTACT_FIELDS = ['name', 'email', 'phone', 'company'];
  var NONE_CODE = 'none';
  var OTHER_CODE = 'other';
  var HIDDEN_ID = /^[a-z][a-z0-9_]{0,39}$/;
  var MAX_HIDDEN_VALUE = 200;
  var MAX_OPEN_TEXT = 5000;
  var MAX_PAGE_URL = 4096;
  // The ids the v1 migration gives a version 1 form's steps (shared/forms_v2.py V1_*_ID).
  var V1_RATING_ID = 'q_rating';
  var V1_TEXT_ID = 'q_text';
  var V1_CONTACT_ID = 'q_contact';
  var V1_ENDING_ID = 'end_thanks';
  var V1_SCALES = { stars: 'star', emoji: 'smiley', numeric: 'number' };
  // A version 1 form's default button text (shared/forms_v2.py V1_DEFAULTS), never shown by the version 1 widget.
  var V1_DEFAULT_SUBMIT = 'Submit Feedback';
  // The I18nText key of a version 1 form that names no language (7.54.00's "the visitor's browser", D15).
  var NO_LANGUAGE = '_';

  /** A config the server sent as schema version 2. */
  function isV2Config(served) {
    return served.schema_version === 2 || Array.isArray(served.questions);
  }

  function i18n(locale, text) {
    var out = {};
    if (nonBlank(text)) out[locale] = text.trim();
    return out;
  }

  /**
   * A version 1 config (title, question, rating_*, text_question, placeholder, collect_*, success_message,
   * submit_button_text) as version 2, by the contract's migration rules (shared/forms_v2.py migrate_v1), so a
   * config cached from before 7.55, or served by a version 1 server, keeps working. Two differences, on purpose:
   * a star rating keeps its exact `rating_max` (such a config goes back to a version 1 server, which checks the
   * rating against it), a follow-up left over from a rating that was turned off is not shown (7.54.00), and the
   * untouched default button text is not shown either (the version 1 widget never showed it).
   *
   * Its fields are read as `c.<field>` (`c = this.config`) and nowhere else in this file: the API's test of its
   * public config (lambda/api/test/test_feedback_form_handler.py) derives "the fields the widget reads" from
   * exactly that spelling. A version 2 config is read through other names (`served`, `raw`).
   */
  function V1Config(config) {
    this.config = config;
  }

  V1Config.prototype.migrate = function() {
    var c = this.config;
    var locale = knownLocale(c.language);
    var key = locale || NO_LANGUAGE;
    var words = STRINGS[locale || uiFallbackLocale()];
    var ratingOn = c.rating_enabled !== false;
    var question = nonBlank(c.question) ? c.question.trim() : '';
    var questions = [];
    if (ratingOn) {
      var kind = own(V1_SCALES, c.rating_type) ? V1_SCALES[c.rating_type] : 'star';
      var max = isInt(c.rating_max) && c.rating_max >= 2 && c.rating_max <= 10 ? c.rating_max : 5;
      questions.push({
        id: V1_RATING_ID, type: 'rating', headline: i18n(key, question || words.rateUs), required: true, scale: kind,
        range: kind === 'number' ? 10 : (kind === 'smiley' ? 5 : max)
      });
    }
    // With a rating, `question` is the rating's and the text step has the follow-up (`text_question`); without
    // one, the text step is the form's question and a follow-up left over from a rating is not shown (7.54.00).
    var followUp = nonBlank(c.text_question) ? c.text_question.trim() : '';
    var text = {
      id: V1_TEXT_ID, type: 'open_text', required: true, long: true, input_type: 'text',
      headline: i18n(key, (ratingOn ? followUp : question) || words.tellUsMore)
    };
    if (nonBlank(c.placeholder)) text.placeholder = i18n(key, c.placeholder);
    questions.push(text);
    var name = c.collect_name === true, email = c.collect_email === true;
    if (name || email) {
      questions.push({
        id: V1_CONTACT_ID, type: 'contact_info', headline: i18n(key, words.contactTitle), required: true,
        fields: { name: { show: name, required: name }, email: { show: email, required: email },
          phone: { show: false, required: false }, company: { show: false, required: false } }
      });
    }
    // The version 1 widget never showed `submit_button_text`, and most forms hold its untouched English default:
    // only one the author wrote labels the last question's button (else the widget's own "Submit").
    var button = nonBlank(c.submit_button_text) ? c.submit_button_text.trim() : '';
    if (button && button !== V1_DEFAULT_SUBMIT) questions[questions.length - 1].button_label = i18n(key, button);
    var welcome = { enabled: false };
    if (nonBlank(c.title)) welcome = { enabled: true, title: i18n(key, c.title), description: i18n(key, c.description) };
    return {
      language: locale, languages: locale ? [locale] : [], textKey: key, welcome: welcome, questions: questions,
      hidden_fields: [],
      endings: [{ id: V1_ENDING_ID, title: i18n(key, nonBlank(c.success_message) ? c.success_message : words.thanks) }]
    };
  };

  /** The words a version 1 form without a language migrates with: the browser's, else English (7.54.00). */
  function uiFallbackLocale() {
    return browserLocales()[0] || 'en';
  }

  /** The test link's state as the config answer gives it (`test: {valid, record}`), or null when it says none. */
  function testInfo(data, served) {
    var raw = isObject(served.test) ? served.test : (isObject(data.test) ? data.test : null);
    if (!raw) return null;
    return { valid: raw.valid !== false, record: raw.record === 'drop' ? 'drop' : 'tag' };
  }

  /**
   * THE one mapping from what the config route answers to what the widget renders: a version 2 config as it is
   * (defensively: a question of an unknown type, or without an id, is left out), a version 1 config migrated.
   * Everything below reads only this shape.
   */
  function toForm(data, config) {
    var served = isObject(config) ? config : {};
    var v2 = isV2Config(served);
    var raw = v2 ? served : new V1Config(served).migrate();
    var language = knownLocale(raw.language);
    var languages = [];
    (Array.isArray(raw.languages) ? raw.languages : []).forEach(function(code) {
      var locale = knownLocale(code);
      if (locale && languages.indexOf(locale) < 0) languages.push(locale);
    });
    if (language && languages.indexOf(language) < 0) languages.unshift(language);
    var seen = {};
    var questions = (Array.isArray(raw.questions) ? raw.questions : []).filter(function(q) {
      var ok = isObject(q) && typeof q.id === 'string' && q.id && TYPES.indexOf(q.type) >= 0 && !own(seen, q.id);
      if (ok) seen[q.id] = true;
      return ok;
    });
    var endings = (Array.isArray(raw.endings) ? raw.endings : []).filter(function(e) {
      return isObject(e) && typeof e.id === 'string' && e.id;
    });
    if (!endings.length) endings = [{ id: null, title: {} }];
    var hiddenIds = [];
    (Array.isArray(raw.hidden_fields) ? raw.hidden_fields : []).forEach(function(field) {
      var id = isObject(field) ? field.id : field;
      if (typeof id === 'string' && HIDDEN_ID.test(id) && hiddenIds.indexOf(id) < 0) hiddenIds.push(id);
    });
    var welcome = isObject(raw.welcome) ? raw.welcome : { enabled: false };
    return {
      v1: !v2,
      enabled: served.enabled === true,
      revision: isInt(served.revision) && served.revision >= 1 ? served.revision : null,
      language: language,
      languages: languages,
      textKey: raw.textKey || language || NO_LANGUAGE,
      welcome: welcome.enabled === true ? welcome : null,
      questions: questions,
      hiddenIds: hiddenIds,
      endings: endings,
      // D15: a version 1 form without a language, migrated to the deployment's, which its author has not
      // confirmed yet. The response is in that language; the widget's own words keep the browser's pick.
      languageAssumed: v2 && served.language_assumed === true,
      theme: isObject(served.theme) ? served.theme : {},
      // D6's `opened` and `left` beacons: a server that serves version 2 takes them on its events route.
      beacon: served.schema_version === 2 || served.beacon === true,
      test: testInfo(isObject(data) ? data : {}, served)
    };
  }

  /** The respondent's language (D4): the link or SDK's, then the browser's first the form has, then the primary.
   * A version 1 form without a language keeps 7.54.00's pick for the widget's own words: the browser's. */
  function chooseLanguage(form, requested) {
    var wanted = knownLocale(requested);
    if (wanted && form.languages.indexOf(wanted) >= 0) return wanted;
    var browser = browserLocales();
    for (var i = 0; i < browser.length; i++) {
      if (form.languages.indexOf(browser[i]) >= 0) return browser[i];
    }
    if (form.language) return form.language;
    return wanted || browser[0] || 'en';
  }

  /** The language of the widget's own words: the respondent's, except while the form's language is only assumed
   * (D15), when they keep 7.54.00's pick (the link's or SDK's, else the browser's). */
  function wordsLanguage(form, requested) {
    var lang = chooseLanguage(form, requested);
    if (!form.languageAssumed) return lang;
    return knownLocale(requested) || browserLocales()[0] || lang;
  }

  // ── Logic (shared/forms_v2_responses.py rule_matches and logic_path, mirrored) ────────────────────────────

  /** The codes a choice answer names (`other` for an "Other" text). */
  function chosenCodes(answer) {
    if (!isObject(answer)) return [];
    var codes = Array.isArray(answer.codes) ? answer.codes.slice() : [];
    if (typeof answer.code === 'string') codes.push(answer.code);
    if (nonBlank(answer.other)) codes.push(OTHER_CODE);
    return codes;
  }

  function equalsValue(q, value, answer) {
    if (q.type === 'single_select' || q.type === 'multi_select') {
      var codes = chosenCodes(answer);
      return codes.length === 1 && codes[0] === value;
    }
    if (q.type === 'open_text') {
      return typeof answer === 'string' && typeof value === 'string' && answer.toLowerCase() === value.toLowerCase();
    }
    if (q.type === 'consent') return answer === (value === true);
    return answer === value;
  }

  function compare(op, value, answer) {
    if (typeof answer !== 'number' || typeof value !== 'number') return false;
    if (op === 'lt') return answer < value;
    if (op === 'lte') return answer <= value;
    if (op === 'gt') return answer > value;
    return answer >= value;
  }

  /** Whether a rule's `when` holds for `answer` (null: not answered; a statement always counts as answered). */
  function ruleMatches(q, when, answer) {
    var op = when.op;
    var answered = answer !== null || q.type === 'statement';
    if (op === 'submitted') return answered;
    if (op === 'skipped') return !answered;
    if (answer === null) return false;
    var value = when.value;
    if (op === 'equals') return equalsValue(q, value, answer);
    if (op === 'not_equals') return !equalsValue(q, value, answer);
    var codes = chosenCodes(answer);
    var listed = Array.isArray(value) ? value : [];
    if (op === 'includes_any') return listed.some(function(code) { return codes.indexOf(code) >= 0; });
    if (op === 'includes_all') return listed.every(function(code) { return codes.indexOf(code) >= 0; });
    if (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') return compare(op, value, answer);
    return false;
  }

  function rulesOf(q) {
    return Array.isArray(q.logic) ? q.logic.filter(isObject) : [];
  }

  /** Whether some rule always matches, so the next question is never reached by "no match": an "Otherwise"
   * stored as trailing `submitted` (and, for an optional question, `skipped`) rules (UX spec §5.3). */
  function alwaysJumps(q) {
    var ops = rulesOf(q).map(function(rule) { return isObject(rule.when) ? rule.when.op : null; });
    var submitted = ops.indexOf('submitted') >= 0;
    return submitted && (q.type === 'statement' || q.required === true || ops.indexOf('skipped') >= 0);
  }

  // ── Choices ───────────────────────────────────────────────────────────────────────────────────────────────

  function optionsOf(q) {
    return (Array.isArray(q.options) ? q.options : []).filter(function(option) {
      return isObject(option) && typeof option.code === 'string' && option.code;
    });
  }

  function enabled(q, key) {
    return isObject(q[key]) && q[key].enabled === true;
  }

  /** `items` in a random order (Fisher-Yates, by `random`: 0 ≤ n < 1), as a new array. */
  function shuffled(items, random) {
    var out = items.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var swap = out[i];
      out[i] = out[j];
      out[j] = swap;
    }
    return out;
  }

  /** The option codes in this respondent's order: shuffled once (none | all | except_last), by `random`
   * (Math.random when none is given). */
  function optionOrder(q, random) {
    var codes = optionsOf(q).map(function(option) { return option.code; });
    var draw = random || Math.random;
    if (q.shuffle === 'all') return shuffled(codes, draw);
    if (q.shuffle === 'except_last' && codes.length > 1) return shuffled(codes.slice(0, -1), draw).concat(codes.slice(-1));
    return codes;
  }

  /** Whether a question still shuffles the same options the same way (the preview keeps its order then). */
  function sameShuffle(a, b) {
    var codes = function(q) { return optionsOf(q).map(function(option) { return option.code; }).join('\n'); };
    return a.shuffle === b.shuffle && codes(a) === codes(b);
  }

  /** A 32-bit FNV-1a hash of `text`. */
  function hashText(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /** A small seeded PRNG (mulberry32): numbers 0 ≤ n < 1, the same ones for the same seed. The preview's shuffle
   * (`preview.seed`), so an author sees one stable order for the whole session, Restart included. */
  function seededRandom(seed) {
    var state = seed >>> 0;
    return function() {
      state = (state + 0x6d2b79f5) >>> 0;
      var t = Math.imul(state ^ (state >>> 15), state | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** `preview.seed` as a 32-bit seed, or null for none (then Shuffle is random, as for a respondent). */
  function previewSeed(value) {
    return typeof value === 'number' && isFinite(value) ? Math.floor(Math.abs(value)) % 4294967296 : null;
  }

  /** The scale a rating, NPS, CSAT or CES question offers: its values and how they are drawn. */
  function scaleOf(q) {
    var low = 1, high = 5, kind = 'number';
    if (q.type === 'nps') { low = 0; high = 10; }
    else if (q.type === 'csat') { kind = 'smiley'; }
    else if (q.type === 'ces') { high = 7; }
    else {
      high = isInt(q.range) && q.range >= 2 && q.range <= 10 ? q.range : 5;
      kind = q.scale === 'star' || q.scale === 'smiley' ? q.scale : 'number';
      // Faces come in 3 to 5 points; any other range is drawn as numbers.
      if (kind === 'smiley' && (high < 3 || high > 5)) kind = 'number';
    }
    var values = [];
    for (var v = low; v <= high; v++) values.push(v);
    return { values: values, low: low, high: high, kind: kind };
  }

  // Drawn faces (no emoji: they follow the theme's colours). Mouths from very bad to very good; a 3- or 4-point
  // scale uses the moods listed for it.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var FACE_MOUTHS = ['M7.5 17 Q12 12.5 16.5 17', 'M8 16.5 Q12 14.5 16 16.5', 'M8 15.5 L16 15.5',
    'M8 14.5 Q12 17 16 14.5', 'M7.5 14 Q12 19 16.5 14'];
  var FACE_MOODS = { 3: [1, 2, 3], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] };

  function svgNode(tag, attributes) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attributes).forEach(function(name) { node.setAttribute(name, String(attributes[name])); });
    return node;
  }

  function drawFace(mood) {
    var svg = svgNode('svg', { viewBox: '0 0 24 24', width: 40, height: 40, 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(svgNode('circle', { cx: 12, cy: 12, r: 10.25, 'stroke-width': 1.5, 'class': 'voc-face-ring' }));
    svg.appendChild(svgNode('circle', { cx: 8.8, cy: 9.6, r: 1.25, stroke: 'none', 'class': 'voc-face-eye' }));
    svg.appendChild(svgNode('circle', { cx: 15.2, cy: 9.6, r: 1.25, stroke: 'none', 'class': 'voc-face-eye' }));
    svg.appendChild(svgNode('path', { d: FACE_MOUTHS[mood], fill: 'none', 'stroke-width': 1.6,
      'stroke-linecap': 'round', 'class': 'voc-face-mouth' }));
    return svg;
  }

  function paintFace(svg, ink, fill) {
    svg.querySelectorAll('.voc-face-ring').forEach(function(node) {
      node.setAttribute('stroke', ink);
      node.setAttribute('fill', fill);
    });
    svg.querySelectorAll('.voc-face-eye').forEach(function(node) { node.setAttribute('fill', ink); });
    svg.querySelectorAll('.voc-face-mouth').forEach(function(node) { node.setAttribute('stroke', ink); });
  }

  // ── Hidden fields and the link ────────────────────────────────────────────────────────────────────────────

  // Read once, when the script runs: the API's iframe page inlines this file before its own link script, which
  // may drop a token from the address before init.
  var LOAD_PATH = '';
  var LOAD_QUERY = '';
  try {
    LOAD_PATH = String(window.location.pathname || '');
    LOAD_QUERY = String(window.location.search || '');
  } catch (e) {
    LOAD_PATH = '';
  }

  /** Whether this page is the API's own iframe page for `formId` (…/feedback-forms/<formId>/iframe). */
  function onOwnPage(formId) {
    var m = /\/feedback-forms\/([^/]+)\/iframe\/?$/.exec(LOAD_PATH);
    if (!m || formId === undefined || formId === null) return false;
    try {
      return decodeURIComponent(m[1]) === String(formId);
    } catch (e) {
      return false;
    }
  }

  /** What the link says (`hf_<id>`, `lang`, `test`): on the API's own page only, plus what its page script
   * handed over on `VoCFeedbackForm` (`linkHidden`, `testToken`, `linkLanguage`). */
  function linkParams(formId) {
    var out = { hidden: {}, test: null, lang: null };
    if (onOwnPage(formId) && typeof URLSearchParams === 'function') {
      var params = new URLSearchParams(LOAD_QUERY);
      params.forEach(function(value, key) {
        // (a hidden field's id only, never a name that reaches the object's prototype: the link only fills fields)
        var id = key.slice(3);
        if (key.indexOf('hf_') === 0 && HIDDEN_ID.test(id) && id !== '__proto__' && id !== 'constructor' &&
            id !== 'prototype') out.hidden[id] = value;
      });
      out.test = params.get('test');
      out.lang = params.get('lang');
    }
    var ns = window.VoCFeedbackForm || {};
    if (isObject(ns.linkHidden)) mergeInto(out.hidden, ns.linkHidden);
    if (nonBlank(ns.testToken)) out.test = ns.testToken;
    if (nonBlank(ns.linkLanguage)) out.lang = ns.linkLanguage;
    return out;
  }

  function mergeInto(target, source) {
    if (!isObject(source)) return target;
    Object.keys(source).forEach(function(key) {
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') target[key] = source[key];
    });
    return target;
  }

  /** Hidden values for the form's declared ids only, each text cut to 200 characters (blank ones dropped). */
  function cleanHidden(raw, declared) {
    var out = {};
    declared.forEach(function(id) {
      if (!own(raw, id)) return;
      var value = raw[id];
      if (typeof value === 'number' && isFinite(value)) value = String(value);
      if (typeof value === 'boolean') value = String(value);
      if (typeof value !== 'string') return;
      value = value.trim().slice(0, MAX_HIDDEN_VALUE).trim();
      if (value) out[id] = value;
    });
    return out;
  }

  /** The form's test link token, when it looks like one (the server checks it). */
  function testToken(raw) {
    return typeof raw === 'string' && /^[A-Za-z0-9_.~-]{1,64}$/.test(raw) ? raw : null;
  }

  // The `dimensions` embed option ({product: 'app', user_type: 'partner'}): kept only as a plain object of up to
  // 10 string/number values. The server drops anything the deployment's dimensions config does not know.
  var MAX_EMBED_DIMENSIONS = 10;
  function embedDimensions(raw) {
    if (!isObject(raw)) return null;
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

  // Set only by the API's own iframe page (a participant ask's link): an opaque token string.
  function participantToken(raw) {
    return typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? raw : null;
  }

  /** A short random id for one respondent's visit (the beacon's session): never stored. */
  function sessionId() {
    var bytes = [];
    var cryptoApi = window.crypto;
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      bytes = Array.prototype.slice.call(cryptoApi.getRandomValues(new Uint8Array(12)));
    } else {
      for (var i = 0; i < 12; i++) bytes.push(Math.floor(Math.random() * 256));
    }
    return bytes.map(function(b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  // ── The widget ────────────────────────────────────────────────────────────────────────────────────────────

  var instances = [];
  var instanceCount = 0;
  // VoCFeedbackForm.setHiddenFields(...): every form on the page, including those that load later.
  var SDK_HIDDEN = {};

  // ── Isolation and the theme ───────────────────────────────────────────────────────────────────────────────

  /**
   * Where the widget draws in `host` (its container): an OPEN shadow root of it, made once and reused by a later
   * init, so neither the page's CSS nor its ids reach the form (a customer's `h2 { color: #fff }` or forms reset, the
   * app's own base layer around the editor's preview), while tests and Playwright can still look inside. The element
   * itself only where Shadow DOM is missing or the element cannot host one (a <form>, a <td>…): everything the form
   * needs is also set inline, so it still renders right there.
   */
  function mountOf(host) {
    if (host.shadowRoot) return host.shadowRoot;
    if (typeof host.attachShadow === 'function') {
      try {
        return host.attachShadow({ mode: 'open' });
      } catch (e) {
        return host;
      }
    }
    return host;
  }

  /** The palette a theme shows, 'light' or 'dark': `forced` (the preview's) first, else its `mode` ('auto' follows
   * the respondent's device, prefers-color-scheme; a theme without one is light). */
  function schemeOf(theme, forced) {
    if (forced === 'light' || forced === 'dark') return forced;
    if (theme.mode === 'dark') return 'dark';
    if (theme.mode === 'auto') return media('(prefers-color-scheme: dark)') ? 'dark' : 'light';
    return 'light';
  }

  /** The font stack of a theme's `font`. `inherit` takes the container's font on a script embed only: the API's own
   * page and the editor's preview have no page font of the form's, so they show the system stack. */
  function fontFor(font, embedded) {
    if (font === 'inherit' && embedded) return 'inherit';
    return own(FONTS, font) ? FONTS[font] : FONTS.system;
  }

  /**
   * The colours and sizes a form is drawn with, from its theme (schema version 2: every field optional, so an old
   * theme gets the defaults). The palette is the one `schemeOf` picks (the top-level colours are the light one,
   * `dark` the dark one), each colour checked (hexColour) and held to the contrast rules the editor and the server
   * share (shared/form_theme.py):
   * - text under 3:1 on its background is replaced (safeContrast);
   * - the option edge (`border`) is the text colour at 55 %, raised until it holds 3:1 (WCAG 1.4.11);
   * - a primary under 3:1 on the background still fills the buttons and the checked boxes, but the focus ring and
   *   the selected edges are drawn in the text colour (`ring`), and a text link in a colour that reads (`link`).
   */
  function themeOf(theme, forced, embedded) {
    var t = isObject(theme) ? theme : {};
    var scheme = schemeOf(t, forced);
    var darkPalette = isObject(t.dark) ? t.dark : {};
    var palette = scheme === 'dark' ? darkPalette : t;
    var defaults = scheme === 'dark' ? KIRO_DARK : KIRO;
    var primary = safeColour(palette.primary_color, defaults.primary);
    var bg = safeColour(palette.background_color, defaults.background);
    var text = safeContrast(safeColour(palette.text_color, defaults.text), bg);
    var radius = /^([0-9]|[1-3][0-9])px$/.test(String(t.border_radius || '')) ? t.border_radius : '8px';
    return {
      scheme: scheme, primary: primary, onPrimary: readableOn(primary), bg: bg, text: text,
      border: rgba(text, alphaFor(text, bg, 0.55, 3)), muted: rgba(text, alphaFor(text, bg, 0.7, 4.5)),
      ring: contrastOf(primary, bg) >= 3 ? primary : text, link: contrastOf(primary, bg) >= 4.5 ? primary : text,
      tint: rgba(primary, 0.1), track: rgba(text, 0.12), radius: radius,
      font: fontFor(t.font, embedded), scale: t.text_size === 'large' ? LARGE_SCALE : 1
    };
  }

  /**
   * The inner root's own declarations: every inherited property the form relies on, inline, so a page whose CSP
   * blocks the widget's stylesheet, or a browser without Shadow DOM, still gets the theme's form (an inline style
   * beats the page's selectors, and nothing is left to inherit from the page). Never on the container itself: the
   * customer's own layout CSS for it stays theirs.
   */
  function rootCss(th) {
    return 'display:block;position:relative;box-sizing:border-box;margin:0;padding:0;border:0;' +
      'background:' + th.bg + ';color:' + th.text + ';color-scheme:' + th.scheme + ';font-family:' + th.font + ';' +
      'font-size:' + Math.round(16 * th.scale) + 'px;line-height:1.5;font-style:normal;font-weight:400;' +
      'font-variant:normal;letter-spacing:normal;word-spacing:normal;text-align:start;text-indent:0;' +
      'text-transform:none;text-shadow:none;white-space:normal;word-break:normal;overflow-wrap:break-word;' +
      'hyphens:manual;-webkit-hyphens:manual;cursor:auto;';
  }

  /**
   * The widget's stylesheet, inside its shadow root: the reset that keeps the page out (`:host` takes nothing from
   * the page but what the page sets on the container itself, a page rule for the container beating a `:host` one),
   * and the enhancements (hover, the focus ring, the placeholder, motion). Rules are scoped to the inner root, so
   * they hold in the light-DOM fallback too. No `contain: paint`: it would clip the focus ring at the edges.
   */
  function styleText(th, scope) {
    var s = '.' + scope;
    return ':host{all:initial;display:block;position:relative;background:' + th.bg + ';color-scheme:' + th.scheme +
        (th.font === 'inherit' ? ';font-family:inherit' : '') + '}' +
      ':host([hidden]){display:none}' +
      s + ',' + s + ' *,' + s + ' *::before,' + s + ' *::after{box-sizing:border-box}' +
      s + ' h1,' + s + ' h2,' + s + ' p,' + s + ' legend{margin:0;color:inherit;font:inherit;letter-spacing:normal;' +
        'text-transform:none;hyphens:manual;-webkit-hyphens:manual}' +
      s + ' input,' + s + ' select,' + s + ' textarea,' + s + ' button{font:inherit;color:inherit;' +
        'letter-spacing:inherit;text-transform:none}' +
      s + ' ::placeholder{color:' + th.muted + ';opacity:1}' +
      // A row's background is inline (rowCss), so its hover needs !important; never on touch, where :hover sticks
      // to the last row tapped and would look picked.
      '@media (hover: hover){' + s + ' .voc-opt:hover{background:' + th.tint + '!important}}' +
      s + ' :focus-visible{outline:3px solid ' + th.ring + ';outline-offset:2px}' +
      s + ' .voc-spin{animation:' + scope + '-spin 0.8s linear infinite}' +
      '@keyframes ' + scope + '-spin{to{transform:rotate(360deg)}}' +
      '@media (prefers-reduced-motion: reduce){' + s + ' *{transition:none!important;animation:none!important}}';
  }

  /** A plain status line in the container (unavailable, failed to load, an invalid test link), in the form's
   * colours (the default ones while the form is unknown). */
  function message(container, text, colours) {
    var th = colours || themeOf({}, null, false);
    var mount = mountOf(container);
    mount.innerHTML = '';
    var root = el('div', rootCss(th));
    root.className = 'voc-root';
    var p = el('p', 'color:' + th.text + ';text-align:center;padding:40px 20px;margin:0;font-size:16px;' +
      'line-height:24px;', text);
    p.setAttribute('role', 'status');
    root.appendChild(p);
    mount.appendChild(root);
  }

  function Widget(container, form, opts) {
    this.container = container;
    // The shadow root (or, without one, the container) the widget draws in, and the inner root it fills there.
    this.mount = mountOf(container);
    this.root = el('div', '');
    this.form = form;
    this.opts = opts;
    this.uid = 'voc' + (++instanceCount);
    this.preview = !!opts.preview;
    // The preview's: a palette shown whatever the device says (setScheme), and Shuffle's seed.
    this.forcedScheme = this.preview && (opts.scheme === 'light' || opts.scheme === 'dark') ? opts.scheme : null;
    this.seed = this.preview ? previewSeed(opts.seed) : null;
    this.apiEndpoint = opts.apiEndpoint;
    this.submitEndpoint = opts.submitEndpoint;
    this.eventsEndpoint = opts.eventsEndpoint;
    this.dimensions = opts.dimensions;
    this.participantToken = opts.participantToken;
    this.testToken = this.preview ? null : opts.testToken;
    this.hidden = mergeInto(mergeInto({}, opts.linkHidden), opts.hidden);
    this.requestedLanguage = opts.language;
    this.session = sessionId();
    // D6: whether the respondent started (passed the welcome card or touched an answer), the furthest question shown,
    // and whether the one `left` beacon or the response went.
    this.started = false;
    this.furthest = -1;
    this.leftSent = false;
    this.submitted = false;
    this.timers = [];
    this.listeners = [];
    // Undo steps for what `listen` cannot remove (an old matchMedia listener, the height observer).
    this.cleanups = [];
    this.indexes();
    this.setLanguage(this.requestedLanguage, true);
    this.reset();
    this.attachKeys();
    this.watchLeaving();
    this.watchScheme();
    this.renderShell();
    this.show(this.firstScreen(), false);
    this.watchHeight();
  }

  /** Where a visit starts: the welcome card, else the first question ('empty' for a draft without one). */
  Widget.prototype.firstScreen = function() {
    if (this.form.welcome) return 'welcome';
    return this.form.questions.length ? 0 : 'empty';
  };

  /** Lookups by id, and the longest path from each question (for progress). */
  Widget.prototype.indexes = function() {
    var form = this.form, self = this;
    this.qIndex = {};
    this.eIndex = {};
    form.questions.forEach(function(q, i) { self.qIndex[q.id] = i; });
    form.endings.forEach(function(e, i) { if (e.id) self.eIndex[e.id] = i; });
    var n = form.questions.length;
    var longest = [];
    for (var i = n - 1; i >= 0; i--) {
      var q = form.questions[i];
      var best = i + 1 < n && !alwaysJumps(q) ? longest[i + 1] : 0;
      rulesOf(q).forEach(function(rule) {
        var to = isObject(rule.then) ? rule.then.jump_to : null;
        if (own(self.qIndex, to) && self.qIndex[to] > i) best = Math.max(best, longest[self.qIndex[to]]);
      });
      longest[i] = 1 + best;
    }
    this.longest = longest;
    var answerable = form.questions.filter(function(q) { return q.type !== 'statement'; });
    var optional = answerable.filter(function(q) { return q.required !== true; }).length;
    // Only the rarer of "Required" and "Optional" is shown (usually "Optional").
    this.mark = optional <= answerable.length - optional ? 'optional' : 'required';
  };

  /** A fresh visit: no answers, this respondent's option orders (the preview's, by its seed: the same each time). */
  Widget.prototype.reset = function() {
    var self = this;
    this.state = {};
    this.orders = {};
    this.history = [];
    this.form.questions.forEach(function(q) {
      if (q.type === 'single_select' || q.type === 'multi_select') self.orders[q.id] = optionOrder(q, self.randomFor(q));
    });
  };

  /** The numbers a question's Shuffle draws: seeded per question in a preview with `seed`, else none (Math.random). */
  Widget.prototype.randomFor = function(q) {
    return this.seed === null ? null : seededRandom(hashText(this.seed + ':' + q.id));
  };

  Widget.prototype.setLanguage = function(requested, initial) {
    // `lang`: the response's language (one of the form's), which its texts are shown in.
    this.lang = chooseLanguage(this.form, requested);
    this.words = STRINGS[wordsLanguage(this.form, requested)] || STRINGS.en;
    // The container says the author's language only when the form names one for sure (a v1 form may not).
    this.langAttr = this.form.language && !this.form.languageAssumed ? this.lang : null;
    if (!initial) this.redraw();
  };

  /** Draw the shell and the screen on show again (another language or palette), keeping the answers, and the
   * focus where it was. */
  Widget.prototype.redraw = function() {
    var focusedId = this.focusedId();
    this.renderShell();
    this.show(this.screen, false);
    if (this.sending) this.setSending(true);
    var again = focusedId ? this.root.querySelector('[id="' + focusedId + '"]') : null;
    if (again && typeof again.focus === 'function') again.focus();
  };

  /** The id of the widget's element that has the focus, or null. */
  Widget.prototype.focusedId = function() {
    var active = this.mount === this.container ? document.activeElement : this.mount.activeElement;
    return active && active.id && this.root.contains(active) ? active.id : null;
  };

  Widget.prototype.applyLanguage = function() {
    var lang = this.langAttr;
    [this.container, this.root].forEach(function(node) {
      if (lang) node.setAttribute('lang', lang);
      else node.removeAttribute('lang');
    });
    // The API's own iframe page: its <html lang> and <title> follow the form, and the page around the form takes
    // its palette (the overscroll area, the page's scrollbar).
    if (!this.preview && onOwnPage(this.opts.formId)) {
      if (lang) document.documentElement.setAttribute('lang', lang);
      document.title = this.words.pageTitle;
      document.documentElement.style.background = this.colours.bg;
      document.documentElement.style.colorScheme = this.colours.scheme;
    }
  };

  /** An I18nText in the respondent's language, else the primary's ('' for none). */
  Widget.prototype.text = function(value) {
    if (!isObject(value)) return '';
    if (nonBlank(value[this.lang])) return value[this.lang];
    return nonBlank(value[this.form.textKey]) ? value[this.form.textKey] : '';
  };

  /** Put an I18nText on `node`; one shown in the primary language says so (`lang`). */
  Widget.prototype.setText = function(node, value, fallback) {
    var shown = this.text(value);
    node.textContent = shown || fallback || '';
    if (shown && !nonBlank(value[this.lang]) && this.form.language && this.form.language !== this.lang) {
      node.setAttribute('lang', this.form.language);
    }
    return node;
  };

  Widget.prototype.id = function(part) {
    return this.uid + '-' + part;
  };

  Widget.prototype.listen = function(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.listeners.push([target, type, handler, options]);
  };

  Widget.prototype.later = function(fn, ms) {
    var timer = setTimeout(fn, ms);
    this.timers.push(timer);
    return timer;
  };

  Widget.prototype.destroy = function() {
    this.timers.forEach(function(timer) { clearTimeout(timer); });
    this.listeners.forEach(function(entry) { entry[0].removeEventListener(entry[1], entry[2], entry[3]); });
    this.cleanups.forEach(function(undo) { undo(); });
    this.timers = [];
    this.listeners = [];
    this.cleanups = [];
    this.watchingHeight = false;
    var index = instances.indexOf(this);
    if (index >= 0) instances.splice(index, 1);
    this.destroyed = true;
  };

  // ── The shell: strip, progress, live region, the screen ──────────────────────────────────────────────────

  /** Whether this is a script embed on someone's page (neither the API's own iframe page nor the editor's preview). */
  Widget.prototype.embedded = function() {
    return !this.preview && !onOwnPage(this.opts.formId);
  };

  Widget.prototype.theme = function() {
    return themeOf(this.form.theme, this.forcedScheme, this.embedded());
  };

  /** A font size (and line height) in px, scaled for `text_size: 'large'`. */
  Widget.prototype.fs = function(size, line) {
    var scale = this.colours.scale;
    return 'font-size:' + Math.round(size * scale) + 'px;' + (line ? 'line-height:' + Math.round(line * scale) + 'px;' : '');
  };

  /** The theme's text colour, on every element that shows text (inline, so no page rule wins where the shadow root
   * is missing). */
  Widget.prototype.ink = function() {
    return 'color:' + this.colours.text + ';';
  };

  /** The widget's stylesheet in its shadow root: an adopted, constructed sheet where the browser has them (a CSP
   * that blocks <style> elements does not stop one), else a <style> element. */
  Widget.prototype.applyStyles = function(css) {
    var mount = this.mount;
    if (mount !== this.container && 'adoptedStyleSheets' in mount && typeof window.CSSStyleSheet === 'function') {
      try {
        this.sheet = this.sheet || new window.CSSStyleSheet();
        this.sheet.replaceSync(css);
        mount.adoptedStyleSheets = [this.sheet];
        return;
      } catch (e) {
        this.sheet = null;
      }
    }
    var style = el('style');
    style.textContent = css;
    mount.appendChild(style);
  };

  /** The shell, in the shadow root: the stylesheet, then ONE inner root holding the strip, the progress bar, the
   * live region and the stage (so every id, `aria-describedby` and `<label for>` resolves in the one root). */
  Widget.prototype.renderShell = function() {
    var mount = this.mount, root = this.root, th = this.colours = this.theme();
    mount.innerHTML = '';
    this.applyStyles(styleText(th, this.uid));
    root.innerHTML = '';
    root.className = 'voc-ff voc-root ' + this.uid;
    root.style.cssText = rootCss(th) + 'min-height:400px;';
    this.applyLanguage();
    mount.appendChild(root);

    var strip = this.stripText();
    if (strip) {
      var note = el('div', 'margin:0;padding:6px 16px;' + this.fs(13, 20) + 'font-weight:600;' +
        'text-align:center;color:' + STRIP_TEXT + ';background:' + (this.preview ? STRIP_PREVIEW : STRIP_TEST) + ';', strip);
      note.className = 'voc-strip';
      note.setAttribute('role', 'note');
      root.appendChild(note);
    }

    var track = el('div', 'height:4px;background:' + th.track + ';');
    track.className = 'voc-progress';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    var bar = el('div', 'height:4px;width:0%;background:' + th.primary + ';transition:width 0.3s ease;');
    track.appendChild(bar);
    root.appendChild(track);
    this.progress = track;
    this.progressBar = bar;

    var live = el('div', SR_ONLY);
    live.className = 'voc-live';
    live.setAttribute('aria-live', 'polite');
    root.appendChild(live);
    this.live = live;

    this.stage = el('div', '');
    root.appendChild(this.stage);
  };

  /**
   * Keys are the form's own: handled in its shadow root (without one, its container), never on the page around it
   * (once per widget). In the shadow root because there `e.target` is the element itself (at the container it would
   * read as the container), and because `change` events stop at the shadow root.
   */
  Widget.prototype.attachKeys = function() {
    var mount = this.mount, self = this;
    this.listen(mount, 'keydown', function(e) { self.onKeydown(e); });
    // `pointerAt` decides an auto-advance; `lastInput` whether a focus ring is drawn (keyboardFocus).
    var pointer = function() {
      self.pointerAt = Date.now();
      self.lastInput = 'pointer';
    };
    var passive = { capture: true, passive: true };
    this.listen(mount, 'pointerdown', pointer, passive);
    this.listen(mount, 'mousedown', pointer, passive);
    this.listen(mount, 'touchstart', pointer, passive);
    this.listen(mount, 'keydown', function() {
      self.pointerAt = 0;
      self.lastInput = 'key';
    }, true);
    var touched = function() { self.started = true; };
    this.listen(mount, 'input', touched, true);
    this.listen(mount, 'change', touched, true);
  };

  /** `mode: 'auto'` follows the device: a change of prefers-color-scheme redraws the form in the other palette
   * (unless the preview forces one). */
  Widget.prototype.watchScheme = function() {
    var self = this, query = null;
    try {
      query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    } catch (e) {
      query = null;
    }
    if (!query) return;
    var onChange = function() {
      if (!self.destroyed && self.colours && self.theme().scheme !== self.colours.scheme) self.redraw();
    };
    if (typeof query.addEventListener === 'function') {
      this.listen(query, 'change', onChange);
    } else if (typeof query.addListener === 'function') {
      query.addListener(onChange);
      this.cleanups.push(function() { query.removeListener(onChange); });
    }
  };

  /** The preview's palette: 'light' or 'dark' whatever the theme and the device say, or null for the theme's own. */
  Widget.prototype.setScheme = function(scheme) {
    this.forcedScheme = scheme === 'light' || scheme === 'dark' ? scheme : null;
    this.redraw();
  };

  Widget.prototype.stripText = function() {
    if (this.preview) return this.words.preview;
    if (!this.testToken) return '';
    return this.form.test && this.form.test.record === 'drop' ? this.words.testDrop : this.words.testKeep;
  };

  Widget.prototype.narrow = function(width) {
    var w = this.root.clientWidth || this.container.clientWidth || 0;
    return w > 0 && w < width;
  };

  /** Show a screen: 'welcome', a question index, or {ending: index}. `focus`: move focus to it (never on the
   * first render, which would pull focus away from a host page). */
  Widget.prototype.show = function(screen, focus) {
    this.timers.forEach(function(timer) { clearTimeout(timer); });
    this.timers = [];
    this.closeDropdown(false);
    this.screen = screen;
    var node, focusTarget;
    if (screen === 'welcome') {
      node = this.buildWelcome();
    } else if (screen === 'empty') {
      node = { root: el('p', this.ink() + 'text-align:center;padding:40px 20px;margin:0;', this.words.unavailable), focus: null };
    } else if (typeof screen === 'number') {
      node = this.buildQuestion(screen);
    } else {
      node = this.buildEnding(screen.ending);
    }
    this.stage.innerHTML = '';
    this.stage.appendChild(node.root);
    this.updateProgress();
    if (!media('(prefers-reduced-motion: reduce)')) {
      node.root.style.opacity = '0';
      node.root.style.transition = 'opacity 200ms ease';
      var raf = window.requestAnimationFrame || function(fn) { return setTimeout(fn, 16); };
      raf(function() { node.root.style.opacity = '1'; });
    }
    focusTarget = node.focus;
    if (focus && focusTarget) focusTarget.focus();
    if (typeof screen === 'number') this.furthest = Math.max(this.furthest, screen);
    this.reportHeight();
  };

  Widget.prototype.updateProgress = function() {
    var screen = this.screen;
    var onQuestion = typeof screen === 'number';
    this.progress.hidden = !onQuestion;
    if (!onQuestion) {
      this.live.textContent = '';
      return;
    }
    var n = this.history.length + 1;
    var m = this.history.length + this.longest[screen];
    var words = fill(this.words.progress, { n: n, m: m });
    this.progress.setAttribute('aria-valuemax', String(m));
    this.progress.setAttribute('aria-valuenow', String(n));
    this.progress.setAttribute('aria-valuetext', words);
    this.progressBar.style.width = Math.round(((n - 1) / m) * 100) + '%';
    this.live.textContent = words;
  };

  // ── Screens ───────────────────────────────────────────────────────────────────────────────────────────────

  // Not rem: a rem is the customer page's root size, which the widget never reads.
  var SCREEN_CSS = 'max-width:640px;margin:0 auto;box-sizing:border-box;';
  // What a page rule may restyle on a heading or a paragraph (where the shadow root is missing), pinned inline.
  var TEXT_RESET = 'letter-spacing:normal;text-transform:none;hyphens:manual;-webkit-hyphens:manual;';

  /** A screen's heading: the theme's text colour inline, so neither a page's `h2 { color }` nor its hyphenation wins. */
  Widget.prototype.headlineCss = function(size, line) {
    return 'margin:0;' + this.fs(size || 24, line || 32) + 'font-weight:600;font-family:inherit;font-style:normal;' +
      this.ink() + TEXT_RESET + 'outline-offset:4px;';
  };

  /** A paragraph of text in the theme's colour, at `size` / `line` px. */
  Widget.prototype.textCss = function(size, line) {
    return this.fs(size, line) + this.ink() + TEXT_RESET;
  };

  Widget.prototype.screenRoot = function() {
    var pad = this.narrow(640) ? '20px' : '40px';
    var root = el('div', SCREEN_CSS + 'padding:' + pad + ' ' + pad + ' 24px;');
    root.className = 'voc-screen';
    return root;
  };

  /** What every button of the widget sets, so a page's `button { text-transform: uppercase }` never reaches one. */
  var BUTTON_RESET = 'font:inherit;font-weight:600;letter-spacing:normal;text-transform:none;text-shadow:none;' +
    'box-shadow:none;cursor:pointer;margin:0;';

  Widget.prototype.primaryButtonCss = function() {
    var th = this.colours;
    return 'min-height:48px;padding:12px 24px;border:2px solid ' + th.primary + ';background:' + th.primary + ';color:' +
      th.onPrimary + ';border-radius:' + th.radius + ';' + BUTTON_RESET;
  };

  Widget.prototype.secondaryButtonCss = function() {
    var th = this.colours;
    return 'min-height:48px;padding:12px 24px;border:2px solid ' + th.border + ';background:transparent;color:' +
      th.text + ';border-radius:' + th.radius + ';' + BUTTON_RESET;
  };

  Widget.prototype.buildWelcome = function() {
    var self = this, w = this.form.welcome, root = this.screenRoot();
    root.style.textAlign = 'center';
    root.style.paddingTop = '64px';
    var h1 = el('h1', this.headlineCss(30, 38) + 'margin:0 0 16px;font-weight:700;');
    h1.setAttribute('tabindex', '-1');
    this.setText(h1, w.title);
    root.appendChild(h1);
    if (this.text(w.description)) {
      root.appendChild(this.setText(el('p', 'margin:0 0 32px;' + this.textCss(18, 28)), w.description));
    }
    var button = el('button', this.primaryButtonCss() + 'min-width:160px;');
    button.type = 'button';
    button.className = 'voc-start';
    this.setText(button, w.button_label, this.words.start + ' →');
    button.onclick = function() { self.start(); };
    root.appendChild(button);
    return { root: root, focus: h1 };
  };

  Widget.prototype.start = function() {
    if (!this.form.questions.length) return;
    this.started = true;
    this.history = [];
    this.show(0, true);
  };

  Widget.prototype.buildEnding = function(index) {
    var ending = this.form.endings[index] || this.form.endings[0];
    var root = this.screenRoot();
    root.style.textAlign = 'center';
    root.style.paddingTop = '64px';
    var mark = el('div', this.fs(48, 56) + 'margin:0 0 16px;color:' + this.colours.ring + ';', '✓');
    mark.setAttribute('aria-hidden', 'true');
    root.appendChild(mark);
    var h2 = el('h2', this.headlineCss(28, 36));
    h2.className = 'voc-ending-title';
    h2.setAttribute('tabindex', '-1');
    this.setText(h2, ending.title, this.words.thanks);
    root.appendChild(h2);
    if (this.text(ending.description)) {
      root.appendChild(this.setText(el('p', 'margin:16px 0 0;' + this.textCss(18, 28)), ending.description));
    }
    var button = isObject(ending.button) ? ending.button : null;
    var href = button ? safeHttpsUrl(button.url) : null;
    if (href && this.text(button.label)) {
      var link = this.newTabLink(href, button.label, this.primaryButtonCss() + 'display:inline-block;margin-top:24px;' +
        'text-decoration:none;');
      root.appendChild(link);
    }
    if (this.preview) {
      var done = el('p', 'margin:24px 0 0;' + this.textCss(13, 20), this.words.previewDone);
      done.className = 'voc-preview-done';
      root.appendChild(done);
    }
    return { root: root, focus: h2 };
  };

  /** A link from the config: an https address (safeHttpsUrl), opened in a new tab without the opener. */
  Widget.prototype.newTabLink = function(href, label, cssText) {
    var link = el('a', cssText);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    this.setText(link, label);
    link.appendChild(document.createTextNode(' ↗'));
    link.appendChild(el('span', SR_ONLY, ' ' + this.words.newTab));
    return link;
  };

  /** The marker under a headline: "Required" or "Optional", whichever is rarer on this form. */
  Widget.prototype.markFor = function(q) {
    if (q.type === 'statement') return '';
    if (this.mark === 'optional' && q.required !== true) return this.words.optional;
    if (this.mark === 'required' && q.required === true) return this.words.required;
    return '';
  };

  Widget.prototype.buildQuestion = function(index) {
    var q = this.form.questions[index];
    var root = this.screenRoot();
    var ctx = { q: q, index: index, headId: this.id('h' + index), errId: this.id('e' + index), describedBy: [] };
    this.ctx = ctx;
    var fieldset = el('fieldset', 'border:0;margin:0;padding:0;min-width:0;background:none;');
    fieldset.className = 'voc-question';
    fieldset.setAttribute('data-question-id', q.id);
    // `float:none`: a page's `legend { float: left }` would pull the heading out of the fieldset's flow.
    var legend = el('legend', 'display:block;float:none;padding:0;margin:0 0 8px;width:100%;border:0;' + this.ink());
    var head = el('h2', this.headlineCss());
    head.id = ctx.headId;
    head.setAttribute('tabindex', '-1');
    this.setText(head, q.headline);
    legend.appendChild(head);
    fieldset.appendChild(legend);
    if (this.text(q.subheader)) {
      var desc = this.setText(el('p', 'margin:0 0 8px;' + this.textCss(16, 24)), q.subheader);
      desc.id = this.id('d' + index);
      ctx.describedBy.push(desc.id);
      fieldset.appendChild(desc);
    }
    var marker = this.markFor(q);
    if (marker) fieldset.appendChild(el('p', 'margin:0 0 8px;' + this.textCss(13, 20), marker));
    var hint = q.type === 'multi_select' ? this.multiHint(q) : '';
    if (hint) {
      var hintEl = el('p', 'margin:0 0 8px;' + this.textCss(14, 20), hint);
      hintEl.className = 'voc-hint';
      hintEl.id = this.id('m' + index);
      ctx.describedBy.push(hintEl.id);
      fieldset.appendChild(hintEl);
    }
    var body = el('div', 'margin-top:16px;');
    fieldset.appendChild(body);
    var err = el('p', 'margin:12px 0 0;' + this.textCss(14, 20) + 'font-weight:600;');
    err.id = ctx.errId;
    err.className = 'voc-error';
    err.setAttribute('role', 'alert');
    ctx.err = err;
    ctx.describedBy.push(err.id);
    ctx.body = body;
    var focus = this.buildControls(ctx);
    fieldset.appendChild(err);
    root.appendChild(fieldset);
    ctx.fieldset = fieldset;
    root.appendChild(this.buildNav(ctx));
    this.refreshNext();
    return { root: root, focus: focus || head };
  };

  Widget.prototype.describe = function(node, ctx, extra) {
    var ids = (extra || []).concat(ctx.describedBy);
    node.setAttribute('aria-describedby', ids.join(' '));
  };

  /**
   * Back and Next, with the notice above them (sending failed, refused, form changed). On a phone the whole bar is
   * sticky at the bottom (UX §11.1): the bar itself, a child of the screen root, so it can stick while the screen
   * scrolls under it (a sticky element never leaves its parent, and a wrapper as tall as the bar would hold it in
   * place). The API's own page scrolls the document, so there it pins to the window; in the editor's preview, to the
   * preview's frame.
   */
  Widget.prototype.buildNav = function(ctx) {
    var self = this, words = this.words, q = ctx.q, th = this.colours;
    var narrow = this.narrow(640);
    var wrap = el('div', narrow
      ? 'position:sticky;bottom:0;z-index:1;margin:24px -20px 0;padding:12px 20px;background:' + th.bg +
        ';border-top:1px solid ' + th.track + ';'
      : 'margin-top:32px;');
    wrap.className = 'voc-nav-bar';
    var notice = el('div', 'margin:0 0 12px;' + this.textCss(14, 20) + 'font-weight:600;');
    notice.className = 'voc-submit-error';
    notice.setAttribute('role', 'alert');
    notice.hidden = true;
    wrap.appendChild(notice);
    this.notice = notice;
    var nav = el('div', narrow
      ? 'display:flex;gap:12px;'
      : 'display:flex;gap:12px;align-items:center;justify-content:flex-end;flex-wrap:wrap;');
    nav.className = 'voc-nav';
    var back = el('button', this.secondaryButtonCss() + (narrow ? 'flex:1 1 0;' : ''), words.previous);
    back.type = 'button';
    back.className = 'voc-back';
    back.hidden = !this.history.length;
    back.onclick = function() { self.back(); };
    var next = el('button', this.primaryButtonCss() + (narrow ? 'flex:1 1 0;' : 'min-width:120px;'));
    next.type = 'button';
    next.className = 'voc-next';
    next.onclick = function() { self.next(); };
    nav.appendChild(back);
    nav.appendChild(next);
    this.nextButton = next;
    var hintWords = q.type === 'open_text' && q.long === true ? words.ctrlEnterHint : words.enterHint;
    if (!narrow && media('(pointer: fine)')) {
      var hint = el('span', this.textCss(13, 20), hintWords);
      hint.className = 'voc-enter-hint';
      hint.setAttribute('aria-hidden', 'true');
      nav.appendChild(hint);
    }
    wrap.appendChild(nav);
    return wrap;
  };

  /** Next's words: the question's own label, Submit when the answers so far end the form here, else Next. */
  Widget.prototype.refreshNext = function() {
    if (!this.nextButton || typeof this.screen !== 'number' || this.sending) return;
    var q = this.form.questions[this.screen];
    var label = isObject(q.cta) && !safeHttpsUrl(q.cta.url) && this.text(q.cta.label) ? q.cta.label : q.button_label;
    var ends = this.targetAfter(this.screen).ending !== undefined;
    this.setText(this.nextButton, label, ends ? this.words.submit : this.words.next);
  };

  // ── Controls per type ─────────────────────────────────────────────────────────────────────────────────────

  Widget.prototype.buildControls = function(ctx) {
    switch (ctx.q.type) {
      case 'open_text': return this.buildOpenText(ctx);
      case 'single_select': return this.buildChoice(ctx, false);
      case 'multi_select': return this.buildChoice(ctx, true);
      case 'statement': return this.buildStatement(ctx);
      case 'consent': return this.buildConsent(ctx);
      case 'contact_info': return this.buildContact(ctx);
      default: return this.buildScale(ctx);
    }
  };

  /** The respondent's answer so far to `q`, as the controls hold it (a draft that changed the question's type in
   * the preview starts it afresh). */
  Widget.prototype.stateOf = function(q) {
    if (own(this.state, q.id) && this.state[q.id].type === q.type) return this.state[q.id];
    var s;
    if (q.type === 'open_text') s = { text: '' };
    else if (q.type === 'single_select') s = { code: null, other: false, otherText: '' };
    else if (q.type === 'multi_select') s = { codes: [], none: false, other: false, otherText: '' };
    else if (q.type === 'consent') s = { checked: false };
    else if (q.type === 'contact_info') s = { name: '', email: '', phone: '', company: '' };
    else s = { value: null };
    s.type = q.type;
    this.state[q.id] = s;
    return s;
  };

  Widget.prototype.inputCss = function() {
    var th = this.colours;
    return 'display:block;width:100%;box-sizing:border-box;min-height:48px;margin:0;padding:12px 14px;font:inherit;' +
      'letter-spacing:normal;text-transform:none;box-shadow:none;' +
      'color:' + th.text + ';background:' + th.bg + ';border:2px solid ' + th.border + ';border-radius:' + th.radius + ';';
  };

  /** A text field's own look (no platform inset or rounding), the same in every browser. */
  var FIELD_APPEARANCE = '-webkit-appearance:none;appearance:none;';

  var INPUT_TYPES = {
    email: { type: 'email', inputmode: 'email', autocomplete: 'email' },
    number: { type: 'text', inputmode: 'decimal' },
    phone: { type: 'tel', inputmode: 'tel', autocomplete: 'tel' },
    url: { type: 'url', inputmode: 'url', autocomplete: 'url' },
    text: { type: 'text' }
  };

  Widget.prototype.maxChars = function(q) {
    return isInt(q.max_chars) && q.max_chars >= 1 && q.max_chars <= MAX_OPEN_TEXT ? q.max_chars : MAX_OPEN_TEXT;
  };

  Widget.prototype.buildOpenText = function(ctx) {
    var self = this, q = ctx.q, s = this.stateOf(q), max = this.maxChars(q);
    var field;
    if (q.long === true) {
      field = el('textarea', this.inputCss() + FIELD_APPEARANCE + 'resize:vertical;min-height:96px;max-height:260px;' +
        'overflow-y:auto;');
      field.rows = 3;
    } else {
      var kind = own(INPUT_TYPES, q.input_type) ? INPUT_TYPES[q.input_type] : INPUT_TYPES.text;
      field = el('input', this.inputCss() + FIELD_APPEARANCE);
      field.type = kind.type;
      if (kind.inputmode) field.setAttribute('inputmode', kind.inputmode);
      if (kind.autocomplete) field.setAttribute('autocomplete', kind.autocomplete);
    }
    field.className = 'voc-input';
    field.id = this.id('i' + ctx.index);
    field.maxLength = max;
    field.placeholder = this.text(q.placeholder) || this.words.textPlaceholder;
    field.value = s.text;
    field.setAttribute('aria-labelledby', ctx.headId);
    if (q.required === true) field.setAttribute('aria-required', 'true');
    var counter = el('p', 'margin:6px 0 0;' + this.textCss(13, 20) + 'text-align:right;');
    counter.id = this.id('c' + ctx.index);
    this.describe(field, ctx, [counter.id]);
    var paint = function() {
      var length = field.value.length;
      counter.textContent = length >= max * 0.8 ? fill(self.words.charCount, { n: length, max: max }) : '';
      if (q.long === true && field.scrollHeight > 0) {
        field.style.height = 'auto';
        field.style.height = Math.min(field.scrollHeight + 4, 260) + 'px';
      }
    };
    field.oninput = function() {
      s.text = field.value;
      self.clearError();
      paint();
      self.refreshNext();
    };
    ctx.body.appendChild(field);
    ctx.body.appendChild(counter);
    paint();
    ctx.first = field;
    return field;
  };

  /** The rows of a choice question in this respondent's order: options, then Other, then None. */
  Widget.prototype.choiceRows = function(q, multi) {
    var byCode = {};
    optionsOf(q).forEach(function(option) { byCode[option.code] = option; });
    var self = this;
    var rows = (this.orders[q.id] || optionOrder(q)).filter(function(code) { return own(byCode, code); })
      .map(function(code) { return { kind: 'option', code: code, label: self.text(byCode[code].label) || code,
        i18n: byCode[code].label }; });
    if (enabled(q, 'other')) rows.push({ kind: 'other', label: this.text(q.other.label) || this.words.other, i18n: q.other.label });
    if (multi && enabled(q, 'none')) rows.push({ kind: 'none', label: this.text(q.none.label) || this.words.none, i18n: q.none.label });
    return rows;
  };

  /** How a choice shows (§11.4): Auto is a list for 6 rows or fewer and a dropdown past that; Chips with a label
   * over 40 characters is a list on a screen narrower than 480 px. */
  Widget.prototype.displayOf = function(q, rows) {
    var display = q.display;
    if (display === 'list' || display === 'dropdown') return display;
    if (display === 'chips') {
      var long = rows.some(function(row) { return row.label.length > 40; });
      return long && this.narrow(480) ? 'list' : 'chips';
    }
    return rows.length <= 6 ? 'list' : 'dropdown';
  };

  Widget.prototype.multiHint = function(q) {
    var words = this.words;
    var min = isInt(q.min) && q.min > 1 ? q.min : 0;
    var max = isInt(q.max) && q.max > 0 ? q.max : 0;
    if (min && max) return min === max ? fill(words.chooseExactly, { n: min }) : fill(words.chooseBetween, { min: min, max: max });
    if (max) return fill(words.chooseUpTo, { n: max });
    if (min) return fill(words.chooseAtLeast, { n: min });
    return words.chooseAll;
  };

  Widget.prototype.buildChoice = function(ctx, multi) {
    var q = ctx.q, rows = this.choiceRows(q, multi);
    var display = this.displayOf(q, rows);
    ctx.rows = rows;
    if (display === 'dropdown') return multi ? this.buildChecklist(ctx, rows) : this.buildSelect(ctx, rows);
    return this.buildChoiceList(ctx, rows, multi, display === 'chips');
  };

  Widget.prototype.isPicked = function(s, row, multi) {
    if (row.kind === 'other') return s.other;
    if (row.kind === 'none') return s.none;
    return multi ? s.codes.indexOf(row.code) >= 0 : (!s.other && s.code === row.code);
  };

  /** Pick or unpick a row; false (with the error said) when a multiple choice is already at its maximum. */
  Widget.prototype.pick = function(q, row, on) {
    var s = this.stateOf(q), multi = q.type === 'multi_select';
    if (!multi) {
      s.code = row.kind === 'option' ? row.code : null;
      s.other = row.kind === 'other';
      return true;
    }
    if (on && row.kind !== 'none') {
      var max = isInt(q.max) && q.max > 0 ? q.max : 0;
      var count = (s.none ? 0 : s.codes.length) + (s.other && !s.none ? 1 : 0);
      if (max && count >= max) {
        this.showError(fill(this.words.tooMany, { n: max }));
        return false;
      }
    }
    if (row.kind === 'none') {
      s.none = on;
      if (on) { s.codes = []; s.other = false; }
    } else {
      s.none = false;
      if (row.kind === 'other') s.other = on;
      else if (on && s.codes.indexOf(row.code) < 0) s.codes.push(row.code);
      else if (!on) s.codes = s.codes.filter(function(code) { return code !== row.code; });
    }
    return true;
  };

  Widget.prototype.rowCss = function(selected, chip) {
    var th = this.colours;
    var base = chip
      ? 'display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:8px 16px;border-radius:999px;'
      : 'display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;min-height:48px;padding:10px 14px;' +
        'border-radius:' + th.radius + ';';
    // `position:relative` holds the visually hidden input inside its row.
    return base + 'position:relative;margin:0;cursor:pointer;border:2px solid ' + (selected ? th.ring : th.border) +
      ';background:' + (selected ? th.tint : 'transparent') + ';color:' + th.text + ';font:inherit;text-align:start;' +
      'letter-spacing:normal;text-transform:none;';
  };

  /** The focus ring around a drawn control: a gap in the background colour, then the ring colour. */
  Widget.prototype.ringShadow = function() {
    return '0 0 0 2px ' + this.colours.bg + ',0 0 0 4px ' + this.colours.ring;
  };

  Widget.prototype.ringCss = function() {
    return 'box-shadow:' + this.ringShadow() + ';';
  };

  /** Whether the focus on `node` is one to show (the browser's :focus-visible, or the last input was not a pointer:
   * the ring is drawn for the keyboard, not after a click or a tap). */
  Widget.prototype.keyboardFocus = function(node) {
    var visible = false;
    try {
      visible = node.matches(':focus-visible');
    } catch (e) {
      visible = false;
    }
    return visible || this.lastInput !== 'pointer';
  };

  // The tick and the dot of a checked box, on a 16 px grid.
  var TICK_PATH = 'M3.5 8.5 6.6 11.5 12.5 4.75';

  /**
   * A choice: the real checkbox or radio, visually hidden but focused, toggled and announced as usual (so Space and
   * the arrow keys keep their native behaviour), and the box the widget draws beside it (`box`: a square, round for
   * a radio). No native box at all, so neither a page's forms reset nor the platform decides how a choice looks:
   * the same in Safari, Chrome and Firefox. `chip`: no box, the chip itself shows the choice. `label`: the row's
   * label (`voc-opt`), which the caller fills.
   */
  Widget.prototype.choiceEntry = function(type, chip) {
    var self = this;
    var entry = { input: el('input', SR_ONLY), label: el('label', ''), box: null, mark: null, radio: type === 'radio',
      focused: false };
    entry.label.className = 'voc-opt';
    entry.input.type = type;
    if (!chip) {
      entry.box = el('span', '');
      entry.box.className = 'voc-box';
      entry.box.setAttribute('aria-hidden', 'true');
      var svg = svgNode('svg', { viewBox: '0 0 16 16', width: '100%', height: '100%', focusable: 'false' });
      entry.mark = entry.radio
        ? svgNode('circle', { cx: 8, cy: 8, r: 3.5, stroke: 'none' })
        : svgNode('path', { d: TICK_PATH, fill: 'none', 'stroke-width': 2.2, 'stroke-linecap': 'round',
          'stroke-linejoin': 'round' });
      svg.appendChild(entry.mark);
      entry.box.appendChild(svg);
    }
    entry.input.onfocus = function() {
      entry.focused = self.keyboardFocus(entry.input);
      if (entry.paint) entry.paint();
    };
    entry.input.onblur = function() {
      entry.focused = false;
      if (entry.paint) entry.paint();
    };
    return entry;
  };

  /** Paint a drawn box: the option edge, or when checked the primary fill (its edge in the ring colour, so a pale
   * primary still shows) with the on-primary tick or dot; the focus ring while the keyboard is on it. */
  Widget.prototype.paintBox = function(entry, checked) {
    var th = this.colours, size = Math.round(20 * th.scale) + 'px';
    entry.box.style.cssText = 'display:inline-flex;flex:none;align-items:center;justify-content:center;' +
      'box-sizing:border-box;width:' + size + ';height:' + size + ';margin:0;padding:0;border:2px solid ' +
      (checked ? th.ring : th.border) + ';border-radius:' + (entry.radio ? '50%' : '4px') + ';background:' +
      (checked ? th.primary : th.bg) + ';' + (entry.focused ? this.ringCss() : '');
    entry.mark.setAttribute(entry.radio ? 'fill' : 'stroke', th.onPrimary);
    entry.mark.style.display = checked ? '' : 'none';
  };

  /** The text box under Other, shown while Other is picked: its wrapper is what `hidden` toggles (an inline
   * `display` on the box itself would win over the attribute). */
  Widget.prototype.otherBox = function(ctx) {
    var self = this, q = ctx.q, s = this.stateOf(q);
    var wrap = el('div', 'margin-top:8px;');
    wrap.className = 'voc-other';
    var box = el('input', this.inputCss() + FIELD_APPEARANCE);
    box.type = 'text';
    box.className = 'voc-other-input';
    box.id = this.id('o' + ctx.index);
    box.maxLength = 1000;
    box.value = s.otherText;
    box.placeholder = this.text(q.other.placeholder) || this.words.otherPlaceholder;
    box.setAttribute('aria-label', this.text(q.other.label) || this.words.other);
    this.describe(box, ctx);
    box.oninput = function() {
      s.otherText = box.value;
      self.clearError();
      self.refreshNext();
    };
    wrap.appendChild(box);
    wrap.input = box;
    return wrap;
  };

  Widget.prototype.buildChoiceList = function(ctx, rows, multi, chips) {
    var self = this, q = ctx.q, s = this.stateOf(q);
    var group = el('div', chips ? 'display:flex;flex-wrap:wrap;gap:8px;' : 'display:flex;flex-direction:column;gap:8px;');
    group.className = 'voc-choices';
    group.setAttribute('role', multi ? 'group' : 'radiogroup');
    group.setAttribute('aria-labelledby', ctx.headId);
    if (!multi && q.required === true) group.setAttribute('aria-required', 'true');
    this.describe(group, ctx);
    var otherBox = enabled(q, 'other') ? this.otherBox(ctx) : null;
    var inputs = [];
    var paint = function(entry) {
      var picked = self.isPicked(s, entry.row, multi);
      entry.input.checked = picked;
      entry.label.style.cssText = self.rowCss(picked, chips) + (chips && entry.focused ? self.ringCss() : '');
      if (entry.box) self.paintBox(entry, picked);
    };
    var repaint = function() {
      inputs.forEach(paint);
      if (otherBox) otherBox.hidden = !s.other;
    };
    rows.forEach(function(row, i) {
      var entry = self.choiceEntry(multi ? 'checkbox' : 'radio', chips);
      var label = entry.label;
      var input = entry.input;
      input.name = self.id('q' + ctx.index);
      input.value = row.kind === 'option' ? row.code : '#' + row.kind;
      input.id = self.id('q' + ctx.index + '-' + i);
      input.onchange = function() {
        var on = multi ? input.checked : true;
        self.clearError();
        if (!self.pick(q, row, on)) input.checked = false;
        repaint();
        self.refreshNext();
        if (row.kind === 'other' && s.other && otherBox) otherBox.input.focus();
        if (!multi && row.kind !== 'other') self.autoAdvance(ctx.index);
      };
      label.appendChild(input);
      if (entry.box) label.appendChild(entry.box);
      var words = el('span', 'flex:1 1 auto;' + self.ink());
      self.setText(words, row.i18n, row.label);
      label.appendChild(words);
      group.appendChild(label);
      entry.row = row;
      entry.paint = function() { paint(entry); };
      inputs.push(entry);
      if (row.kind === 'other' && otherBox && !chips) group.appendChild(otherBox);
    });
    ctx.body.appendChild(group);
    if (otherBox && chips) ctx.body.appendChild(otherBox);
    repaint();
    var checked = inputs.filter(function(entry) { return entry.input.checked; })[0];
    ctx.first = (checked || inputs[0] || {}).input;
    return null;
  };

  Widget.prototype.buildSelect = function(ctx, rows) {
    var self = this, q = ctx.q, s = this.stateOf(q);
    // The platform's own select (its list is the device's, in the palette `color-scheme` names), never a page's
    // restyled one (`appearance: base-select`).
    var select = el('select', this.inputCss() + '-webkit-appearance:menulist;appearance:auto;cursor:pointer;');
    select.className = 'voc-select';
    select.id = this.id('s' + ctx.index);
    select.setAttribute('aria-labelledby', ctx.headId);
    if (q.required === true) select.setAttribute('aria-required', 'true');
    this.describe(select, ctx);
    var placeholder = el('option', '', this.words.choose);
    placeholder.value = '';
    select.appendChild(placeholder);
    rows.forEach(function(row) {
      var option = el('option', '', row.label);
      option.value = row.kind === 'option' ? row.code : '#other';
      select.appendChild(option);
    });
    select.value = s.other ? '#other' : (s.code || '');
    var otherBox = enabled(q, 'other') ? this.otherBox(ctx) : null;
    if (otherBox) otherBox.hidden = !s.other;
    select.onchange = function() {
      self.clearError();
      var value = select.value;
      s.other = value === '#other';
      s.code = value && value !== '#other' ? value : null;
      if (otherBox) {
        otherBox.hidden = !s.other;
        if (s.other) otherBox.input.focus();
      }
      self.refreshNext();
    };
    ctx.body.appendChild(select);
    if (otherBox) ctx.body.appendChild(otherBox);
    ctx.first = select;
    return null;
  };

  /** A multiple choice past 6 rows: a button that opens an inline checklist (never <select multiple>). */
  Widget.prototype.buildChecklist = function(ctx, rows) {
    var self = this, q = ctx.q, s = this.stateOf(q);
    var panelId = this.id('p' + ctx.index);
    var toggle = el('button', this.inputCss() + FIELD_APPEARANCE + 'text-align:start;cursor:pointer;');
    toggle.type = 'button';
    toggle.className = 'voc-dropdown';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', panelId);
    var toggleWords = el('span', this.ink());
    toggleWords.id = this.id('t' + ctx.index);
    toggle.appendChild(toggleWords);
    toggle.setAttribute('aria-labelledby', ctx.headId + ' ' + toggleWords.id);
    var panel = el('div', 'margin-top:8px;padding:8px;border:2px solid ' + this.colours.border + ';border-radius:' +
      this.colours.radius + ';max-height:320px;overflow-y:auto;');
    panel.id = panelId;
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-labelledby', ctx.headId);
    this.describe(panel, ctx);
    var search = null, empty = el('p', 'margin:8px 0;' + this.textCss(14, 20), this.words.noMatches);
    empty.className = 'voc-no-matches';
    empty.hidden = true;
    if (rows.length > 12) {
      search = el('input', this.inputCss() + FIELD_APPEARANCE + 'margin-bottom:8px;');
      search.type = 'search';
      search.className = 'voc-search';
      search.setAttribute('aria-label', this.words.search);
      search.placeholder = this.words.search;
      search.setAttribute('data-voc-noenter', '');
      panel.appendChild(search);
    }
    var list = el('div', 'display:flex;flex-direction:column;gap:6px;');
    panel.appendChild(list);
    panel.appendChild(empty);
    var otherBox = enabled(q, 'other') ? this.otherBox(ctx) : null;
    var entries = [];
    var paint = function(entry) {
      var picked = self.isPicked(s, entry.row, true);
      entry.input.checked = picked;
      entry.label.style.cssText = self.rowCss(picked, false) + (entry.filtered ? 'display:none;' : '');
      self.paintBox(entry, picked);
    };
    var repaint = function() {
      entries.forEach(paint);
      var count = (s.none ? 1 : s.codes.length) + (s.other && !s.none ? 1 : 0);
      toggleWords.textContent = count ? fill(self.words.selected, { n: count }) : self.words.choose;
      if (otherBox) otherBox.hidden = !s.other;
    };
    rows.forEach(function(row, i) {
      var entry = self.choiceEntry('checkbox', false);
      var label = entry.label;
      var input = entry.input;
      input.value = row.kind === 'option' ? row.code : '#' + row.kind;
      input.id = self.id('q' + ctx.index + '-' + i);
      input.onchange = function() {
        self.clearError();
        if (!self.pick(q, row, input.checked)) input.checked = false;
        repaint();
        self.refreshNext();
      };
      label.appendChild(input);
      label.appendChild(entry.box);
      label.appendChild(self.setText(el('span', 'flex:1 1 auto;' + self.ink()), row.i18n, row.label));
      list.appendChild(label);
      entry.row = row;
      entry.filtered = false;
      entry.paint = function() { paint(entry); };
      entries.push(entry);
    });
    if (search) {
      search.oninput = function() {
        var needle = search.value.trim().toLowerCase();
        var shown = 0;
        entries.forEach(function(entry) {
          entry.filtered = !!needle && entry.row.label.toLowerCase().indexOf(needle) < 0;
          if (!entry.filtered) shown += 1;
        });
        empty.hidden = shown > 0;
        repaint();
      };
    }
    toggle.onclick = function() {
      if (panel.hidden) self.openDropdown(toggle, panel, search || (entries[0] && entries[0].input));
      else self.closeDropdown(true);
    };
    ctx.body.appendChild(toggle);
    ctx.body.appendChild(panel);
    if (otherBox) ctx.body.appendChild(otherBox);
    repaint();
    ctx.first = toggle;
    return null;
  };

  Widget.prototype.openDropdown = function(toggle, panel, focus) {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    this.dropdown = { toggle: toggle, panel: panel };
    if (focus) focus.focus();
  };

  /** Close the open checklist (true when one was open); `refocus` puts focus back on its button. */
  Widget.prototype.closeDropdown = function(refocus) {
    var open = this.dropdown;
    if (!open) return false;
    open.panel.hidden = true;
    open.toggle.setAttribute('aria-expanded', 'false');
    this.dropdown = null;
    if (refocus) open.toggle.focus();
    return true;
  };

  Widget.prototype.scaleName = function(q, scale, value, i) {
    var words = this.words;
    var name = fill(words.outOf, { n: value, max: scale.high });
    if (scale.kind === 'smiley') name = this.faceWords(scale)[i] + ' (' + name + ')';
    var end = i === 0 ? this.text(q.lower_label) : (i === scale.values.length - 1 ? this.text(q.upper_label) : '');
    return end ? name + ', ' + end : name;
  };

  Widget.prototype.faceWords = function(scale) {
    return this.words['faces' + scale.values.length] || this.words.faces5;
  };

  /** Rating, NPS, CSAT and CES: a radio group of stars, numbered cells or drawn faces, with its end labels. */
  Widget.prototype.buildScale = function(ctx) {
    var self = this, q = ctx.q, s = this.stateOf(q), th = this.colours, scale = scaleOf(q);
    var many = scale.values.length > 7;
    var group = el('div', 'display:flex;gap:' + (many ? '2px' : '8px') + ';flex-wrap:' +
      (scale.kind === 'number' ? 'nowrap' : 'wrap') + ';');
    group.className = 'voc-scale';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', ctx.headId);
    if (q.required === true) group.setAttribute('aria-required', 'true');
    this.describe(group, ctx);
    var cells = [];
    // NPS's 11 cells stay on one row on a 360 px phone (24 px targets with 2 px gaps, WCAG 2.5.8), 40 px from 480 px.
    var minWidth = scale.kind === 'number' ? (this.narrow(480) ? '24px' : '40px') : '44px';
    var faceWords = this.faceWords(scale);
    var moods = FACE_MOODS[scale.values.length] || FACE_MOODS[5];
    var paint = function(shown) {
      cells.forEach(function(cell) {
        var v = cell.value;
        var on = scale.kind === 'star' ? (shown !== null && v <= shown) : v === shown;
        var picked = v === s.value;
        cell.input.checked = picked;
        if (scale.kind === 'star') {
          cell.visual.style.color = on ? th.primary : th.border;
        } else if (scale.kind === 'smiley') {
          paintFace(cell.visual, on ? th.onPrimary : th.text, on ? th.primary : 'none');
        } else {
          cell.label.style.background = on ? th.primary : 'transparent';
          cell.label.style.color = on ? th.onPrimary : th.text;
          cell.label.style.borderColor = on ? th.ring : th.border;
        }
      });
    };
    scale.values.forEach(function(value, i) {
      var label = el('label', 'position:relative;margin:0;letter-spacing:normal;text-transform:none;color:' + th.text +
        ';' + (scale.kind === 'number'
        ? 'flex:1 1 0;min-width:' + minWidth + ';max-width:64px;min-height:48px;display:flex;align-items:center;' +
          'justify-content:center;border:2px solid ' + th.border + ';border-radius:' + th.radius + ';cursor:pointer;' +
          'font-weight:600;font-variant-numeric:tabular-nums;'
        : 'display:flex;flex-direction:column;align-items:center;gap:4px;min-width:44px;min-height:44px;cursor:pointer;' +
          'padding:2px;border-radius:' + th.radius + ';'));
      label.className = 'voc-scale-cell';
      var input = el('input', SR_ONLY);
      input.type = 'radio';
      input.name = self.id('q' + ctx.index);
      input.value = String(value);
      input.id = self.id('q' + ctx.index + '-' + i);
      input.onfocus = function() { label.style.boxShadow = self.keyboardFocus(input) ? self.ringShadow() : ''; };
      input.onblur = function() { label.style.boxShadow = ''; };
      input.onchange = function() {
        s.value = value;
        self.clearError();
        paint(value);
        self.refreshNext();
        self.autoAdvance(ctx.index);
      };
      var visual;
      if (scale.kind === 'star') {
        visual = el('span', self.fs(36, 40), '★');
      } else if (scale.kind === 'smiley') {
        visual = drawFace(moods[i]);
      } else {
        visual = el('span', '', String(value));
      }
      visual.setAttribute('aria-hidden', 'true');
      label.appendChild(input);
      label.appendChild(visual);
      label.appendChild(el('span', SR_ONLY, self.scaleName(q, scale, value, i)));
      if (scale.kind === 'smiley') {
        var word = el('span', self.textCss(13, 18) + 'text-align:center;', faceWords[i]);
        word.setAttribute('aria-hidden', 'true');
        label.appendChild(word);
      }
      if (scale.kind === 'star') {
        label.onmouseenter = function() { paint(value); };
        label.onmouseleave = function() { paint(s.value); };
      }
      group.appendChild(label);
      cells.push({ value: value, input: input, label: label, visual: visual });
    });
    ctx.body.appendChild(group);
    var lower = this.text(q.lower_label), upper = this.text(q.upper_label);
    if (lower || upper) {
      // The end words, always shown (never hover-only); the end radios carry them in their names too.
      var ends = el('div', 'display:flex;justify-content:space-between;gap:16px;margin-top:8px;' +
        this.textCss(14, 20));
      ends.className = 'voc-scale-ends';
      ends.setAttribute('aria-hidden', 'true');
      ends.appendChild(this.setText(el('span', this.ink()), q.lower_label));
      ends.appendChild(this.setText(el('span', this.ink() + 'text-align:right;'), q.upper_label));
      ctx.body.appendChild(ends);
    }
    paint(s.value);
    var checked = cells.filter(function(cell) { return cell.value === s.value; })[0];
    ctx.first = (checked || cells[0]).input;
    return null;
  };

  /** After a pick with a pointer (a tap or click), move on in 300 ms, so the choice is seen. Never after a key:
   * arrow keys walk the radios, and Enter goes on (WCAG 3.2.2). */
  Widget.prototype.autoAdvance = function(index) {
    var self = this;
    if (!this.pointerAt || Date.now() - this.pointerAt > 1500) return;
    this.pointerAt = 0;
    this.later(function() {
      if (self.screen === index && !self.sending) self.next();
    }, 300);
  };

  Widget.prototype.buildStatement = function(ctx) {
    var q = ctx.q, cta = isObject(q.cta) ? q.cta : null;
    var href = cta ? safeHttpsUrl(cta.url) : null;
    if (href && this.text(cta.label)) {
      var th = this.colours;
      var link = this.newTabLink(href, cta.label, 'display:inline-flex;align-items:center;min-height:44px;' +
        'font-weight:600;color:' + th.link + ';text-decoration:underline;letter-spacing:normal;text-transform:none;');
      link.className = 'voc-cta';
      ctx.body.appendChild(link);
    }
    return null;
  };

  Widget.prototype.buildConsent = function(ctx) {
    var self = this, q = ctx.q, s = this.stateOf(q);
    var entry = this.choiceEntry('checkbox', false);
    var label = entry.label;
    var box = entry.input;
    box.id = this.id('i' + ctx.index);
    box.checked = s.checked;
    if (q.required === true) box.setAttribute('aria-required', 'true');
    this.describe(box, ctx);
    var paint = function() {
      label.style.cssText = self.rowCss(s.checked, false);
      self.paintBox(entry, s.checked);
    };
    entry.paint = paint;
    box.onchange = function() {
      s.checked = box.checked;
      self.clearError();
      paint();
      self.refreshNext();
    };
    label.appendChild(box);
    label.appendChild(entry.box);
    label.appendChild(this.setText(el('span', 'flex:1 1 auto;' + this.ink()), q.label));
    ctx.body.appendChild(label);
    paint();
    ctx.first = box;
    return null;
  };

  var CONTACT_INPUTS = {
    name: { type: 'text', autocomplete: 'name' },
    email: { type: 'email', autocomplete: 'email', inputmode: 'email' },
    phone: { type: 'tel', autocomplete: 'tel', inputmode: 'tel' },
    company: { type: 'text', autocomplete: 'organization' }
  };

  function contactField(q, name) {
    var fields = isObject(q.fields) ? q.fields : {};
    return isObject(fields[name]) ? fields[name] : {};
  }

  Widget.prototype.buildContact = function(ctx) {
    var self = this, q = ctx.q, s = this.stateOf(q);
    ctx.inputs = {};
    CONTACT_FIELDS.forEach(function(name) {
      var field = contactField(q, name);
      if (field.show !== true) return;
      var spec = CONTACT_INPUTS[name];
      var wrap = el('div', 'margin:0 0 16px;');
      var input = el('input', self.inputCss() + FIELD_APPEARANCE);
      input.id = self.id('f' + ctx.index + '-' + name);
      input.type = spec.type;
      input.setAttribute('autocomplete', spec.autocomplete);
      if (spec.inputmode) input.setAttribute('inputmode', spec.inputmode);
      input.maxLength = name === 'email' ? 254 : (name === 'phone' ? 40 : 200);
      input.value = s[name];
      if (field.required === true) input.setAttribute('aria-required', 'true');
      self.describe(input, ctx);
      var label = el('label', 'display:block;margin:0 0 6px;font-weight:600;' + self.ink() + TEXT_RESET,
        self.words[name]);
      label.htmlFor = input.id;
      if (field.required === true) {
        label.appendChild(document.createTextNode(' '));
        label.appendChild(el('span', 'font-weight:400;' + self.fs(13) + 'margin-left:4px;' + self.ink(),
          self.words.required));
      }
      input.oninput = function() {
        s[name] = input.value;
        input.removeAttribute('aria-invalid');
        self.clearError();
        self.refreshNext();
      };
      wrap.appendChild(label);
      wrap.appendChild(input);
      ctx.body.appendChild(wrap);
      ctx.inputs[name] = input;
      if (!ctx.first) ctx.first = input;
    });
    return null;
  };

  // ── Answers, checks and the path ─────────────────────────────────────────────────────────────────────────

  /** The question's answer in the response v2 shape, or null for none. An optional consent left unticked is false. */
  Widget.prototype.valueOf = function(q) {
    var s = this.stateOf(q), text;
    if (q.type === 'open_text') {
      text = s.text.trim();
      return text ? text : null;
    }
    if (q.type === 'single_select') {
      if (s.other) {
        text = s.otherText.trim();
        return text ? { other: text } : null;
      }
      return s.code ? { code: s.code } : null;
    }
    if (q.type === 'multi_select') {
      var codes = s.none ? [NONE_CODE] : optionsOf(q).map(function(option) { return option.code; })
        .filter(function(code) { return s.codes.indexOf(code) >= 0; });
      text = s.other && !s.none ? s.otherText.trim() : '';
      if (!codes.length && !text) return null;
      var out = { codes: codes };
      if (text) out.other = text;
      return out;
    }
    if (q.type === 'consent') return s.checked === true;
    if (q.type === 'contact_info') {
      var contact = {};
      CONTACT_FIELDS.forEach(function(name) {
        var value = contactField(q, name).show === true ? s[name].trim() : '';
        if (value) contact[name] = value;
      });
      return Object.keys(contact).length ? contact : null;
    }
    if (q.type === 'statement') return null;
    return isInt(s.value) ? s.value : null;
  };

  /** The answer the logic sees: as the server normalizes it (a declined consent is no answer). */
  Widget.prototype.logicValue = function(q) {
    var value = this.valueOf(q);
    return q.type === 'consent' && value !== true ? null : value;
  };

  /** Where the form goes after question `index`: {question: i} or {ending: i}. The first matching rule wins; a jump
   * goes only forward; with no match (or a target that is not there) the next question, then the first ending. */
  Widget.prototype.targetAfter = function(index) {
    var q = this.form.questions[index], value = this.logicValue(q), rules = rulesOf(q);
    for (var i = 0; i < rules.length; i++) {
      if (!ruleMatches(q, isObject(rules[i].when) ? rules[i].when : {}, value)) continue;
      var to = isObject(rules[i].then) ? rules[i].then.jump_to : null;
      if (own(this.qIndex, to) && this.qIndex[to] > index) return { question: this.qIndex[to] };
      if (own(this.eIndex, to)) return { ending: this.eIndex[to] };
      break;
    }
    return index + 1 < this.form.questions.length ? { question: index + 1 } : { ending: 0 };
  };

  /** What stops the respondent on this question, in their words ('' for nothing). Also `field`, for contact. */
  Widget.prototype.check = function(q) {
    var words = this.words, s = this.stateOf(q), value = this.valueOf(q), required = q.required === true;
    if (q.type === 'open_text') {
      if (value === null) return { message: required ? words.typeAnswer : '' };
      var kind = q.long === true ? 'text' : q.input_type;
      if (kind === 'email' && (value.length > 254 || !EMAIL.test(value))) return { message: words.invalidEmail };
      if (kind === 'number' && !(NUMBER.test(value) && isFinite(Number(value)))) return { message: words.invalidNumber };
      if (kind === 'phone' && !this.validPhone(value)) return { message: words.invalidPhone };
      if (kind === 'url' && !validWebAddress(value)) return { message: words.invalidUrl };
      return { message: value.length > this.maxChars(q) ? fill(words.charCount, { n: value.length, max: this.maxChars(q) }) : '' };
    }
    if (q.type === 'single_select' || q.type === 'multi_select') {
      if (s.other && !s.none && !s.otherText.trim()) return { message: words.otherRequired, other: true };
      if (value === null) return { message: required ? words.chooseAnswer : '' };
      if (q.type === 'single_select' || s.none) return { message: '' };
      var count = value.codes.length + (value.other ? 1 : 0);
      var min = isInt(q.min) && q.min >= 1 ? q.min : 1;
      var max = isInt(q.max) && q.max > 0 ? q.max : 0;
      if (count < min) return { message: fill(words.tooFew, { n: min }) };
      if (max && count > max) return { message: fill(words.tooMany, { n: max }) };
      return { message: '' };
    }
    if (q.type === 'consent') return { message: required && !s.checked ? words.consentRequired : '' };
    if (q.type === 'contact_info') return this.checkContact(q, value);
    if (q.type === 'statement') return { message: '' };
    return { message: required && value === null ? words.chooseAnswer : '' };
  };

  Widget.prototype.validPhone = function(value) {
    return PHONE.test(value) && value.replace(/[^0-9]/g, '').length >= 3;
  };

  Widget.prototype.checkContact = function(q, value) {
    var words = this.words, s = this.stateOf(q), self = this;
    var shown = CONTACT_FIELDS.filter(function(name) { return contactField(q, name).show === true; });
    var result = { message: '' };
    if (value === null) {
      if (q.required === true) result = { message: words.typeAnswer, field: shown[0] };
      return result;
    }
    shown.some(function(name) {
      var text = s[name].trim();
      if (!text && contactField(q, name).required === true) result = { message: words.typeAnswer, field: name };
      else if (text && name === 'email' && !EMAIL.test(text)) result = { message: words.invalidEmail, field: name };
      else if (text && name === 'phone' && !self.validPhone(text)) result = { message: words.invalidPhone, field: name };
      return !!result.message;
    });
    return result;
  };

  Widget.prototype.showError = function(text, field) {
    var ctx = this.ctx;
    if (!ctx || !ctx.err) return;
    ctx.err.textContent = '';
    if (!text) return;
    var mark = el('span', this.ink(), '✕ ');
    mark.setAttribute('aria-hidden', 'true');
    ctx.err.appendChild(mark);
    ctx.err.appendChild(document.createTextNode(text));
    if (field && ctx.inputs && ctx.inputs[field]) ctx.inputs[field].setAttribute('aria-invalid', 'true');
  };

  Widget.prototype.clearError = function() {
    if (this.ctx && this.ctx.err) this.ctx.err.textContent = '';
    if (this.notice) {
      this.notice.textContent = '';
      this.notice.hidden = true;
    }
  };

  /** Focus the control the respondent has to fix (focus stays on the controls, never on the message). */
  Widget.prototype.focusProblem = function(problem) {
    var ctx = this.ctx;
    if (!ctx) return;
    var target = ctx.first;
    if (problem.field && ctx.inputs && ctx.inputs[problem.field]) target = ctx.inputs[problem.field];
    if (problem.other) target = this.root.querySelector('.voc-other-input') || target;
    if (target && typeof target.focus === 'function') target.focus();
  };

  // ── Moving ────────────────────────────────────────────────────────────────────────────────────────────────

  Widget.prototype.next = function() {
    if (this.sending || typeof this.screen !== 'number') return;
    var q = this.form.questions[this.screen];
    var problem = this.check(q);
    if (problem.message) {
      this.showError(problem.message, problem.field);
      this.focusProblem(problem);
      return;
    }
    this.clearError();
    this.started = true;
    var target = this.targetAfter(this.screen);
    if (target.question !== undefined) {
      this.history.push(this.screen);
      this.show(target.question, true);
      return;
    }
    this.finish(target.ending);
  };

  Widget.prototype.back = function() {
    if (this.sending || !this.history.length) return;
    this.show(this.history.pop(), true);
  };

  /** The questions this respondent was shown, in order: the path the server checks the answers against. */
  Widget.prototype.path = function() {
    return typeof this.screen === 'number' ? this.history.concat([this.screen]) : this.history.slice();
  };

  Widget.prototype.finish = function(endingIndex) {
    if (this.preview) {
      this.history = this.path();
      this.show({ ending: endingIndex }, true);
      return;
    }
    this.submit(endingIndex);
  };

  Widget.prototype.answers = function(path) {
    var self = this, answers = {};
    path.forEach(function(index) {
      var q = self.form.questions[index];
      if (q.type === 'statement') return;
      var value = self.valueOf(q);
      if (value !== null) answers[q.id] = value;
    });
    return answers;
  };

  /** The respondent's hidden values: link, then `hidden`, then setHiddenFields; declared ids only. */
  Widget.prototype.hiddenValues = function() {
    var merged = mergeInto(mergeInto({}, this.hidden), SDK_HIDDEN);
    mergeInto(merged, this.sdkHidden);
    return cleanHidden(merged, this.form.hiddenIds);
  };

  Widget.prototype.setHiddenFields = function(values) {
    this.sdkHidden = mergeInto(this.sdkHidden || {}, values);
  };

  function pageUrl() {
    var href = '';
    try { href = String(window.location.href); } catch (e) { href = ''; }
    return href && href.length <= MAX_PAGE_URL ? href : null;
  }

  /** The submission: the response v2 shape, or for a version 1 config (one served by a version 1 server) the
   * version 1 body that server takes, built from the same answers. */
  Widget.prototype.payload = function(endingIndex) {
    var answers = this.answers(this.path());
    var url = pageUrl();
    var body;
    if (this.form.v1) {
      var contact = answers[V1_CONTACT_ID] || {};
      var text = answers[V1_TEXT_ID] || '';
      var rating = own(answers, V1_RATING_ID) ? answers[V1_RATING_ID] : null;
      // One flat literal: lib/stacks/api-request-validation.test.ts reads its names against the API's request
      // model (FeedbackFormSubmission).
      var payload = { text: text, rating: rating, name: contact.name || null, email: contact.email || null, page_url: url };
      body = payload;
    } else {
      body = { answers: answers, hidden: this.hiddenValues(), language: this.lang };
      if (this.form.revision !== null) body.form_revision = this.form.revision;
      var ending = this.form.endings[endingIndex];
      if (ending && ending.id) body.ending_id = ending.id;
      if (typeof this.opts.formId === 'string' && this.opts.formId) body.form_id = this.opts.formId;
      if (url) body.page_url = url;
      // The `left` beacon's session: a respondent who left (a tab switch) and came back to submit is not counted as
      // a drop-off (the server drops that session's `left`).
      body.session = this.session;
      // Where it was answered (the forms list's channels): never anything about the person.
      body.channel = this.channel();
    }
    if (this.dimensions) body.dimensions = this.dimensions;
    if (this.participantToken) body.participant_token = this.participantToken;
    if (this.testToken) body.test = this.testToken;
    return body;
  };

  Widget.prototype.setSending = function(on) {
    this.sending = on;
    var next = this.nextButton;
    if (!next) return;
    next.disabled = on;
    if (this.ctx && this.ctx.fieldset) this.ctx.fieldset.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on) {
      next.textContent = '';
      var spinner = el('span', 'display:inline-block;width:14px;height:14px;margin-right:8px;vertical-align:-2px;' +
        'border:2px solid currentColor;border-right-color:transparent;border-radius:50%;');
      spinner.className = 'voc-spin';
      spinner.setAttribute('aria-hidden', 'true');
      next.appendChild(spinner);
      next.appendChild(document.createTextNode(this.words.sending));
    } else {
      this.refreshNext();
    }
  };

  Widget.prototype.submit = function(endingIndex) {
    var self = this;
    if (this.sending) return;
    this.clearError();
    this.setSending(true);
    var body = this.payload(endingIndex);
    fetch(this.apiEndpoint + this.submitEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function(response) {
        var read = typeof response.json === 'function' ? response.json() : Promise.resolve({});
        return read.then(null, function() { return {}; }).then(function(result) {
          return { status: typeof response.status === 'number' ? response.status : 200, body: isObject(result) ? result : {} };
        });
      })
      .then(function(answer) { self.afterSubmit(answer, endingIndex); }, function() {
        self.setSending(false);
        self.showNotice(self.words.submitFailed, self.words.retry, function() { self.submit(endingIndex); });
      });
  };

  Widget.prototype.afterSubmit = function(answer, endingIndex) {
    var self = this, status = answer.status, result = answer.body;
    this.setSending(false);
    if (status < 300 && result.success === true) {
      this.submitted = true;
      var reached = own(this.eIndex, result.ending_id) ? this.eIndex[result.ending_id] : endingIndex;
      this.history = this.path();
      this.show({ ending: reached }, true);
      return;
    }
    if (status === 409) {
      this.showNotice(this.words.formChanged, this.words.reload, function() { self.reload(); });
      return;
    }
    if (status === 403 && this.testToken) {
      this.destroy();
      message(this.container, this.words.testInvalid, this.colours);
      return;
    }
    if (status === 400 || status === 422) {
      this.refused(result);
      return;
    }
    this.showNotice(this.words.submitFailed, this.words.retry, function() { self.submit(endingIndex); });
  };

  /** A refused answer (D8: `code` and `question_id`): back to that question with its reason in the respondent's
   * words. The server's own English is never shown. */
  Widget.prototype.refused = function(result) {
    var qid = typeof result.question_id === 'string' ? result.question_id
      : (isObject(result.details) && typeof result.details.question_id === 'string' ? result.details.question_id : null);
    var path = this.path();
    var index = own(this.qIndex, qid) ? this.qIndex[qid] : -1;
    var at = path.indexOf(index);
    if (at >= 0) {
      this.history = path.slice(0, at);
      this.show(index, true);
      this.showError(this.refusalWords(this.form.questions[index], result.code));
    }
    this.showNotice(this.words.refused);
  };

  Widget.prototype.refusalWords = function(q, code) {
    var words = this.words;
    var problem = this.check(q);
    if (problem.message) return problem.message;
    if (code === 'selection_count') {
      return isInt(q.max) && q.max > 0 ? fill(words.tooMany, { n: q.max }) : fill(words.tooFew, { n: isInt(q.min) ? q.min : 1 });
    }
    if (code === 'answer_required') {
      if (q.type === 'consent') return words.consentRequired;
      return q.type === 'open_text' || q.type === 'contact_info' ? words.typeAnswer : words.chooseAnswer;
    }
    if (q.type === 'open_text') {
      var byType = { email: words.invalidEmail, number: words.invalidNumber, phone: words.invalidPhone, url: words.invalidUrl };
      if (own(byType, q.input_type) && q.long !== true) return byType[q.input_type];
    }
    return words.refused;
  };

  /** The notice by the buttons (an alert), with an optional action (Try again, Reload). */
  Widget.prototype.showNotice = function(text, actionWords, action) {
    var notice = this.notice;
    if (!notice) return;
    notice.textContent = '';
    notice.appendChild(el('span', this.ink(), text));
    if (actionWords && action) {
      var button = el('button', this.secondaryButtonCss() + 'display:block;margin-top:8px;', actionWords);
      button.type = 'button';
      button.className = 'voc-notice-action';
      button.onclick = action;
      notice.appendChild(button);
    }
    notice.hidden = false;
  };

  /** The form changed mid-way: load it again from the server and start over (never reloads the host page). */
  Widget.prototype.reload = function() {
    this.destroy();
    boot(this.container, this.opts.raw, this.onCreated);
  };

  // ── Keys: the form's own only ─────────────────────────────────────────────────────────────────────────────

  Widget.prototype.onKeydown = function(e) {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (this.closeDropdown(true)) e.preventDefault();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    // The element the key was pressed on, even where an event is retargeted at the shadow host.
    var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    var target = path[0] || e.target || {};
    var tag = String(target.tagName || '').toUpperCase();
    // A button's or a link's own Enter is its click: handled once, by it.
    if (tag === 'BUTTON' || tag === 'A') return;
    if (tag === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
    if (target.hasAttribute && target.hasAttribute('data-voc-noenter')) {
      e.preventDefault();
      return;
    }
    if (this.screen === 'welcome') {
      e.preventDefault();
      this.start();
    } else if (typeof this.screen === 'number') {
      e.preventDefault();
      this.next();
    }
  };

  // ── The editor's preview ──────────────────────────────────────────────────────────────────────────────────

  /** The screen on show as goTo names it: a question's id, 'welcome' or 'end:<ending id>' (null for none). */
  Widget.prototype.screenName = function() {
    var screen = this.screen;
    if (typeof screen === 'number') return this.form.questions[screen].id;
    if (screen === 'welcome') return 'welcome';
    var ending = isObject(screen) ? this.form.endings[screen.ending] : null;
    return ending && ending.id ? 'end:' + ending.id : null;
  };

  /** The screen goTo's `target` names in this form, or null when it has no such screen (the welcome screen of a
   * form that has none, an ending or a question that is gone). */
  Widget.prototype.screenFor = function(target) {
    if (target === 'welcome') return this.form.welcome ? 'welcome' : null;
    if (typeof target !== 'string') return null;
    if (target.indexOf('end:') === 0) {
      var endingId = target.slice(4);
      return own(this.eIndex, endingId) ? { ending: this.eIndex[endingId] } : null;
    }
    return own(this.qIndex, target) ? this.qIndex[target] : null;
  };

  /**
   * A new draft: the same screen when it is still there (a question, the welcome screen, an ending: the author
   * editing it keeps seeing it), the answers kept by id, focus left alone. A question keeps its shuffled order
   * while its options and its Shuffle are unchanged (an added option shows at once).
   */
  Widget.prototype.update = function(config) {
    var current = this.screenName();
    var old = { form: this.form, qIndex: this.qIndex };
    var state = this.state, orders = this.orders, history = this.history.map(function(i) { return this.form.questions[i].id; }, this);
    this.form = toForm({}, config);
    this.indexes();
    this.setLanguage(this.requestedLanguage, true);
    this.reset();
    var self = this;
    Object.keys(state).forEach(function(id) { if (own(self.qIndex, id)) self.state[id] = state[id]; });
    Object.keys(orders).forEach(function(id) {
      if (!own(self.qIndex, id) || !own(old.qIndex, id)) return;
      var before = old.form.questions[old.qIndex[id]], now = self.form.questions[self.qIndex[id]];
      if (sameShuffle(before, now)) self.orders[id] = orders[id];
    });
    this.history = history.filter(function(id) { return own(self.qIndex, id); }).map(function(id) { return self.qIndex[id]; });
    this.renderShell();
    var screen = current === null ? null : this.screenFor(current);
    this.show(screen === null ? this.firstScreen() : screen, false);
  };

  /** Show the screen `target` names: a question's id, 'welcome' or 'end:<ending id>' (the editor's selected card),
   * as a fresh visit; nothing when the form has no such screen. */
  Widget.prototype.goTo = function(target) {
    var screen = this.screenFor(target);
    if (screen === null) return;
    this.state = {};
    this.history = [];
    this.show(screen, false);
  };

  Widget.prototype.restart = function() {
    this.reset();
    this.show(this.firstScreen(), false);
  };

  /** Preview messages from this page's own origin only (the app that framed it): config, goTo, restart, language,
   * scheme. */
  Widget.prototype.listenForPreview = function() {
    var self = this;
    this.listen(window, 'message', function(e) {
      if (e.origin !== window.location.origin) return;
      var parent = window.parent && window.parent !== window ? window.parent : window;
      if (e.source && e.source !== parent) return;
      var data = e.data;
      if (!isObject(data) || data.type !== 'voc-form-preview') return;
      if (data.action === 'config' && isObject(data.config)) self.update(data.config);
      else if (data.action === 'goTo' && typeof data.questionId === 'string') self.goTo(data.questionId);
      else if (data.action === 'goTo' && typeof data.target === 'string') self.goTo(data.target);
      else if (data.action === 'restart') self.restart();
      else if (data.action === 'scheme') self.setScheme(data.scheme);
      else if (data.action === 'language') {
        self.requestedLanguage = data.language;
        self.setLanguage(data.language, false);
      }
    });
  };

  /** How this widget runs: `link` (the API's own page, opened as it is: a link, a QR code, a WebView), `iframe` (that
   * page framed in another, the iframe snippet) or `script` (a script embed on someone's own page). */
  Widget.prototype.channel = function() {
    if (!onOwnPage(this.opts.formId)) return 'script';
    return framed() ? 'iframe' : 'link';
  };

  // ── The iframe snippet's auto-height ──────────────────────────────────────────────────────────────────────

  /** Whether this page is framed (a cross-origin parent included). */
  function framed() {
    try {
      return window.parent !== window;
    } catch (e) {
      return true;
    }
  }

  /**
   * On the API's own iframe page, when framed, tell the parent page how tall the form is, so the iframe snippet's
   * resizer can fit the frame to it: `{type: 'voc-form-height', height: <px>}` to `window.parent` (targetOrigin '*':
   * the parent is the customer's page, whatever its origin, and the height is all it says). Sent when the height
   * changes (a ResizeObserver where there is one, else on each screen), at most once per animation frame. Never in
   * the preview, never from a script embed.
   */
  Widget.prototype.watchHeight = function() {
    if (this.preview || !onOwnPage(this.opts.formId) || !framed()) return;
    var self = this;
    this.watchingHeight = true;
    this.lastHeight = null;
    if (typeof window.ResizeObserver === 'function') {
      var observer = new window.ResizeObserver(function() { self.reportHeight(); });
      observer.observe(this.root);
      this.cleanups.push(function() { observer.disconnect(); });
    }
    this.reportHeight();
  };

  Widget.prototype.reportHeight = function() {
    if (!this.watchingHeight || this.heightFrame) return;
    var self = this;
    var raf = window.requestAnimationFrame || function(fn) { return setTimeout(fn, 16); };
    this.heightFrame = raf(function() {
      self.heightFrame = null;
      if (!self.watchingHeight) return;
      var height = Math.ceil(self.root.getBoundingClientRect().height);
      if (height === self.lastHeight) return;
      self.lastHeight = height;
      try {
        window.parent.postMessage({ type: 'voc-form-height', height: height }, '*');
      } catch (e) {
        self.watchingHeight = false;
      }
    });
  };

  // ── D6's two beacons: the open, and where a respondent who started left; never an answer ─────────────────

  /** Leaving is `pagehide`, or the page going hidden (the one a phone reliably fires). Never in the preview. */
  Widget.prototype.watchLeaving = function() {
    if (this.preview) return;
    var self = this;
    this.listen(window, 'pagehide', function() { self.left(); });
    this.listen(document, 'visibilitychange', function() {
      if (document.visibilityState === 'hidden') self.left();
    });
  };

  /**
   * `{event: {kind: 'opened', session, revision?}, test?}` on the events route: the form was shown. Sent once per page
   * load per form (`boot` decides, OPEN_COUNTED), never in the preview; the config read itself counts nothing.
   */
  Widget.prototype.opened = function() {
    if (this.preview || !this.form.beacon || !this.apiEndpoint) return;
    this.beacon({ kind: 'opened', session: this.session });
  };

  /**
   * `{event: {kind: 'left', question_id, session, revision?}, test?}` on the events route, at most once, and only
   * for a respondent who started and has not submitted (nor is sending): the furthest question they reached, which
   * the server counts.
   */
  Widget.prototype.left = function() {
    if (this.preview || this.destroyed || this.leftSent || this.submitted || this.sending || !this.started) return;
    var q = this.form.questions[this.furthest];
    var attached = this.container.isConnected !== false && document.documentElement.contains(this.container);
    if (!q || !this.form.beacon || !this.apiEndpoint || !attached) return;
    this.leftSent = true;
    this.beacon({ kind: 'left', question_id: q.id, session: this.session });
  };

  /**
   * One funnel `event` (with the form's revision when it has one, and the test link's token) on the events route
   * (`eventsEndpoint`): its own route and API Gateway throttle, so the beacons never spend the submit route's limit,
   * which is the real responses'. By navigator.sendBeacon with a text body (a simple request: no preflight), else a
   * keepalive fetch. Never an answer.
   */
  Widget.prototype.beacon = function(event) {
    if (this.form.revision !== null) event.revision = this.form.revision;
    var body = { event: event };
    if (this.testToken) body.test = this.testToken;
    var url = this.apiEndpoint + this.eventsEndpoint, data = JSON.stringify(body);
    try {
      var nav = window.navigator;
      if (nav && typeof nav.sendBeacon === 'function' && nav.sendBeacon(url, data)) return;
      fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: data })
        .then(null, ignoreBeaconFailure);
    } catch (e) {
      ignoreBeaconFailure();
    }
  };

  /** A lost beacon costs one funnel count; the respondent never hears of it. */
  function ignoreBeaconFailure() {
    return null;
  }

  // ── Start ─────────────────────────────────────────────────────────────────────────────────────────────────

  function resolveContainer(target) {
    if (typeof target === 'string') return document.querySelector(target);
    return target && target.nodeType === 1 ? target : null;
  }

  /** The options as the widget uses them: endpoints, tokens, the link's values. */
  function readOptions(options) {
    var formId = options.formId;
    var link = linkParams(formId);
    var test = testToken(options.test) || testToken(link.test);
    var configEndpoint = options.configEndpoint || '/feedback-forms/' + formId + '/config';
    if (test) configEndpoint += (configEndpoint.indexOf('?') >= 0 ? '&' : '?') + 'test=' + encodeURIComponent(test);
    return {
      raw: options,
      formId: formId,
      apiEndpoint: String(options.apiEndpoint || '').replace(/\/+$/, ''),
      configEndpoint: configEndpoint,
      submitEndpoint: options.submitEndpoint || '/feedback-forms/' + formId + '/submit',
      eventsEndpoint: options.eventsEndpoint || '/feedback-forms/' + formId + '/events',
      language: options.language || link.lang,
      hidden: isObject(options.hidden) ? options.hidden : {},
      linkHidden: link.hidden,
      testToken: test,
      dimensions: embedDimensions(options.dimensions),
      participantToken: participantToken((window.VoCFeedbackForm || {}).participantToken)
    };
  }

  // The forms whose open this page load has counted (D6; by config address, the test link's token included): a
  // reload after "This form was updated", or a second init, shows the form again without a second `opened` beacon.
  var OPEN_COUNTED = {};

  /** Fetch the config and start the widget in `container`; `onCreated` gets the widget once it exists. */
  function boot(container, options, onCreated) {
    var opts = readOptions(options);
    if (!opts.apiEndpoint) return;
    var url = opts.apiEndpoint + opts.configEndpoint;
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var answer = isObject(data) ? data : {};
        var config = isObject(answer.config) ? answer.config : answer;
        var form = toForm(answer, config);
        var words = STRINGS[wordsLanguage(form, opts.language)];
        var colours = themeOf(form.theme, null, !onOwnPage(opts.formId));
        if (opts.testToken && form.test && !form.test.valid) {
          message(container, words.testInvalid, colours);
          return;
        }
        // A test link opens the form even while it's off (D2); its token is checked again on submit.
        var usable = answer.success === true && (form.enabled || opts.testToken) && form.questions.length > 0;
        if (!usable) {
          message(container, words.unavailable, colours);
          return;
        }
        var widget = new Widget(container, form, opts);
        widget.onCreated = onCreated;
        instances.push(widget);
        if (!own(OPEN_COUNTED, url)) {
          OPEN_COUNTED[url] = true;
          widget.opened();
        }
        if (onCreated) onCreated(widget);
      })
      .then(null, function() {
        message(container, STRINGS[chooseLanguage({ languages: [], language: null }, opts.language)].loadFailed);
      });
  }

  window.VoCFeedbackForm = {
    /** Start a form in `options.container`; returns a handle (setHiddenFields, and the preview's controls). */
    init: function(options) {
      options = isObject(options) ? options : {};
      var container = resolveContainer(options.container);
      if (!container) return undefined;
      instances.slice().forEach(function(widget) { if (widget.container === container) widget.destroy(); });
      var widget = null;
      var pendingHidden = {};
      var handle = {
        setHiddenFields: function(values) {
          mergeInto(pendingHidden, values);
          if (widget) widget.setHiddenFields(values);
        },
        update: function(config) { if (widget && widget.preview) widget.update(config); },
        goTo: function(target) { if (widget && widget.preview) widget.goTo(target); },
        restart: function() { if (widget && widget.preview) widget.restart(); },
        setLanguage: function(language) {
          if (!widget) return;
          widget.requestedLanguage = language;
          widget.setLanguage(language, false);
        },
        setScheme: function(scheme) { if (widget && widget.preview) widget.setScheme(scheme); },
        destroy: function() { if (widget) widget.destroy(); }
      };
      if (isObject(options.preview)) {
        var preview = options.preview;
        var opts = readOptions(options);
        opts.preview = true;
        opts.seed = preview.seed;
        opts.scheme = preview.scheme;
        widget = new Widget(container, toForm({}, preview.config), opts);
        instances.push(widget);
        widget.listenForPreview();
        return handle;
      }
      boot(container, options, function(created) {
        widget = created;
        widget.setHiddenFields(pendingHidden);
      });
      // (A reload after "This form was updated" builds a new widget through the same callback.)
      return handle;
    },

    /** Hidden-field values for every form on this page (the SDK's call); undeclared ids are dropped at submit. */
    setHiddenFields: function(values) {
      mergeInto(SDK_HIDDEN, values);
    }
  };

  // No HTML-escape helper: every dynamic string this widget renders (the form's copy, its own STRINGS) is set
  // through `textContent` or an attribute, and the only `innerHTML` writes clear an element (constant '').
})();
