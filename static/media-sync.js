/* Shared, synchronized audio/video playback for the projector and player pages. */
(function (global) {
  'use strict';

  let mediaElement = null;
  let mediaKey = '';
  let lastSequence = -1;
  let lastAppliedElement = null;
  let latestState = null;
  let blocked = false;
  let endedSequence = -1;
  let mountId = '';
  let statusId = '';
  let noticeId = '';

  function activeMediaSource(s) {
    if (s && s.screen_mode === 'media_fullscreen' && s.screen_media) {
      return { id: 0, media: s.screen_media.url, media_type: s.screen_media.type, scope: 'screen' };
    }
    const q = s && s.current_question;
    return q ? { id: Number(q.id || 0), media: q.media, media_type: q.media_type, scope: 'question' } : null;
  }

  function isPlayableQuestion(q) {
    return !!(q && q.media && (q.media_type === 'audio' || q.media_type === 'video'));
  }

  function currentTarget(s, control) {
    const position = Math.max(0, Number(control.position || 0));
    if (control.action !== 'playing') return position;
    const serverNow = Number(s.server_time || Date.now() / 1000);
    const changedAt = Number(control.updated_at || serverNow);
    return position + Math.max(0, serverNow - changedAt);
  }

  function setStatus(message) {
    const el = document.getElementById(statusId);
    if (el) el.textContent = message || '';
  }

  function setNotice(visible, message) {
    const el = document.getElementById(noticeId);
    if (!el) return;
    if (message) {
      const text = el.querySelector('[data-media-notice-text]');
      if (text) text.textContent = message;
    }
    el.classList.toggle('hidden', !visible);
  }

  function ensureMediaElement(q) {
    const key = `${q.media_type}|${q.media}`;
    if (mediaElement && mediaKey === key) return mediaElement;

    if (mediaElement) {
      mediaElement.pause();
      mediaElement.removeAttribute('src');
      mediaElement.load();
    }

    mediaElement = document.createElement(q.media_type);
    mediaElement.className = q.media_type === 'video' ? 'synced-video' : 'synced-audio';
    mediaElement.preload = 'auto';
    mediaElement.controls = false;
    mediaElement.loop = false;
    if (q.media_type === 'video') {
      mediaElement.playsInline = true;
      mediaElement.setAttribute('playsinline', '');
    }
    mediaElement.src = q.media;
    mediaElement.addEventListener('ended', () => {
      const s = latestState;
      const control = s && s.media_control;
      const target = s && activeMediaSource(s);
      if (s && control && target && control.action === 'playing' && String(control.scope || 'question') === target.scope && Number(control.question_id) === Number(target.id)) {
        endedSequence = Number(control.sequence);
        setNotice(false);
        setStatus('Трек завершён · для повтора ведущий может нажать «С начала»');
      }
    });
    mediaElement.addEventListener('error', () => {
      setStatus('Не удалось загрузить медиафайл');
    });
    mediaKey = key;
    lastAppliedElement = null;
    blocked = false;
    return mediaElement;
  }

  function safeSeek(target) {
    if (!mediaElement || !Number.isFinite(target) || mediaElement.readyState < 1) return;
    const duration = Number(mediaElement.duration);
    if (Number.isFinite(duration) && duration > 0) target = Math.min(target, Math.max(0, duration - 0.05));
    try {
      if (Math.abs(Number(mediaElement.currentTime || 0) - target) > 0.15) mediaElement.currentTime = target;
    } catch (_) {}
  }

  function attemptPlay(target) {
    if (!mediaElement) return;
    safeSeek(target);
    let promise;
    try { promise = mediaElement.play(); }
    catch (error) {
      blocked = true;
      setNotice(true, 'Браузер заблокировал автоматический запуск звука. Нажмите, чтобы включить синхронное воспроизведение.');
      setStatus('Ожидается разрешение на воспроизведение');
      return;
    }
    if (promise && typeof promise.then === 'function') {
      promise.then(() => {
        blocked = false;
        setNotice(false);
        setStatus(mediaElement.tagName === 'VIDEO' ? 'Видео воспроизводится синхронно' : 'Аудио воспроизводится синхронно');
      }).catch(() => {
        blocked = true;
        setNotice(true, 'Браузер заблокировал автоматический запуск. Нажмите кнопку ниже один раз, чтобы разрешить звук и синхронизацию.');
        setStatus('Ожидается разрешение на воспроизведение');
      });
    }
  }

  function apply(s, options) {
    options = options || {};
    mountId = options.mountId || mountId;
    statusId = options.statusId || statusId;
    noticeId = options.noticeId || noticeId;
    latestState = s;

    const q = activeMediaSource(s);
    const mount = document.getElementById(mountId);
    if (!mount || !isPlayableQuestion(q)) {
      if (mediaElement) mediaElement.pause();
      setNotice(false);
      setStatus('');
      return;
    }

    const element = ensureMediaElement(q);
    if (element.parentElement !== mount) mount.replaceChildren(element);

    const control = s.media_control || {};
    const matches = String(control.scope || 'question') === q.scope && Number(control.question_id) === Number(q.id) && String(control.url || '') === String(q.media || '');
    if (!matches) {
      element.pause();
      safeSeek(0);
      setStatus(q.scope === 'screen' ? 'Медиа готово · ожидает запуска ведущим' : 'Трек готов · ожидает запуска ведущим');
      setNotice(false);
      return;
    }

    const seq = Number(control.sequence || 0);
    const isNewCommand = seq !== lastSequence || element !== lastAppliedElement;
    const target = currentTarget(s, control);

    if (control.action === 'playing') {
      if (isNewCommand && seq !== lastSequence) endedSequence = -1;
      const duration = Number(element.duration);
      if (endedSequence === seq || (element.readyState >= 1 && Number.isFinite(duration) && duration > 0 && target >= duration - 0.05)) {
        endedSequence = seq;
        element.pause();
        setStatus('Трек уже завершён · для повтора ведущий может нажать «С начала»');
        setNotice(false);
        return;
      }
      if (isNewCommand) {
        lastSequence = seq;
        lastAppliedElement = element;
        endedSequence = -1;
        if (element.readyState >= 1) {
          safeSeek(target);
          if (!blocked) attemptPlay(target);
          else setStatus('Ожидается разрешение на воспроизведение');
        } else {
          element.addEventListener('loadedmetadata', () => {
            if (latestState) apply(latestState, options);
          }, { once: true });
        }
      } else {
        if (element.readyState >= 1) {
          const drift = Math.abs(Number(element.currentTime || 0) - target);
          if (drift > 1.15) safeSeek(target);
        }
        if (element.paused && !blocked && element.readyState >= 1) attemptPlay(target);
      }
      if (blocked) setNotice(true);
    } else {
      if (isNewCommand) {
        lastSequence = seq;
        lastAppliedElement = element;
        element.pause();
        if (element.readyState >= 1) safeSeek(target);
      } else if (element.readyState >= 1) {
        const drift = Math.abs(Number(element.currentTime || 0) - target);
        if (drift > 1.15) safeSeek(target);
      }
      setNotice(false);
      if (control.action === 'paused') setStatus('Пауза · продолжение доступно у ведущего');
      else setStatus('Воспроизведение остановлено');
    }
  }

  function unlock() {
    if (!mediaElement) return;
    blocked = false;
    const s = latestState;
    const control = s && s.media_control;
    const target = s && activeMediaSource(s);
    if (control && target && control.action === 'playing' && String(control.scope || 'question') === target.scope && Number(control.question_id) === Number(target.id)) {
      const target = currentTarget(s, control);
      safeSeek(target);
      try {
        const promise = mediaElement.play();
        if (promise && typeof promise.then === 'function') {
          promise.then(() => {
            setNotice(false);
            setStatus(mediaElement.tagName === 'VIDEO' ? 'Видео воспроизводится синхронно' : 'Аудио воспроизводится синхронно');
          }).catch(() => {
            blocked = true;
            setNotice(true, 'Не удалось включить звук. Проверьте громкость и повторите нажатие.');
          });
        }
      } catch (_) {
        blocked = true;
        setNotice(true, 'Не удалось включить звук. Повторите нажатие.');
      }
    } else {
      // Prime the browser's media permission silently before the host starts the track.
      const wasMuted = mediaElement.muted;
      mediaElement.muted = true;
      try {
        const promise = mediaElement.play();
        if (promise && typeof promise.then === 'function') {
          promise.then(() => {
            mediaElement.pause();
            mediaElement.muted = wasMuted;
            safeSeek(0);
            setNotice(false);
            setStatus('Звук разрешён · ожидаем запуска ведущим');
          }).catch(() => {
            mediaElement.muted = wasMuted;
            blocked = true;
            setNotice(true, 'Браузер не разрешил воспроизведение. Повторите нажатие.');
          });
        } else {
          mediaElement.pause();
          mediaElement.muted = wasMuted;
        }
      } catch (_) {
        mediaElement.muted = wasMuted;
        blocked = true;
        setNotice(true, 'Браузер не разрешил воспроизведение. Повторите нажатие.');
      }
    }
  }

  global.QuizMediaSync = { apply, unlock };
})(window);
