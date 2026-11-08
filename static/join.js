let pid=Number(localStorage.getItem('qc_pid')||0),S=null,lastQuestion=0,submitted=false,lastResultQuestion=0,resultRequest=0,registering=false,presenceCheck=false;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalize=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g,' ');
async function register(){
  if(registering||pid)return;
  const button=$('joinButton');registering=true;if(button){button.disabled=true;button.dataset.originalText=button.innerHTML;button.innerHTML='Подключаемся…';}
  $('err').textContent='';
  try{
    const name=$('name').value.trim();if(!name)throw Error('Введите имя');
    const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    const j=await r.json();if(!r.ok)throw Error(j.detail||'Не удалось подключиться');
    pid=Number(j.participant_id);localStorage.setItem('qc_pid',pid);localStorage.setItem('qc_game_id',S?.game?.id||0);
    showJoined();await presence();
    // Pull a fresh state instead of rendering a possibly older websocket snapshot.
    const fresh=await fetch('/api/state').then(x=>x.json());renderAndSync(fresh);
  }catch(e){$('err').textContent=e.message;}
  finally{registering=false;if(button&&pid===0){button.disabled=false;button.innerHTML=button.dataset.originalText||'Присоединиться <span>→</span>';}}
}
function showJoined(){$('register').classList.add('hidden');$('registerClosed').classList.add('hidden');$('joined').classList.remove('hidden');}
function clearPlayerSession(){pid=0;localStorage.removeItem('qc_pid');localStorage.removeItem('qc_game_id');lastQuestion=0;submitted=false;lastResultQuestion=0;$('joined').classList.add('hidden');if(S)renderAndSync(S);}
function answerValue(){const els=[...document.querySelectorAll('[name="playerAnswer"]:checked')];if(els.length)return els.map(x=>x.value).join(', ');const el=document.querySelector('[name="playerAnswer"]');return el?.value?.trim()||'';}
async function sendAnswer(){
  const text=answerValue();if(!text){$('answerStatus').textContent='Сначала выберите или введите ответ.';return;}
  const btn=document.querySelector('#answerBox button');btn.disabled=true;$('answerStatus').textContent='Отправляем ответ…';
  try{const r=await fetch('/api/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participant_id:pid,text})});const j=await r.json();if(!r.ok)throw Error(j.detail||'Не удалось отправить ответ');submitted=true;$('answerStatus').textContent='✓ Ответ принят! Можно изменить его до окончания времени.';}
  catch(e){$('answerStatus').textContent=e.message;btn.disabled=false;}
}
async function presence(){
  if(!pid||presenceCheck)return;const checkingPid=pid;presenceCheck=true;
  try{const r=await fetch('/api/presence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participant_id:checkingPid})});if(!r.ok&&pid===checkingPid)clearPlayerSession();}
  catch{}finally{presenceCheck=false;}
}
async function sendReaction(emoji){
  if(!pid)return;const el=$('reactionStatus');
  try{const r=await fetch('/api/reaction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participant_id:pid,emoji})});const j=await r.json();if(!r.ok)throw Error(j.detail||'Не удалось отправить реакцию');el.textContent='Реакция отправлена!';}
  catch(e){el.textContent=e.message;}
}
function correctValues(q){return new Set(String(q.correct_answer||'').split(',').map(normalize).filter(Boolean));}
function renderStats(s){
  const q=s.current_question,stats=s.answer_stats||[],correctSet=correctValues(q);
  return `<div class="player-result-total">${s.answer_count||0} <small>ответов получено</small></div><div class="player-muted">Распределение ответов всех участников</div>${stats.length?stats.map(a=>`<div class="player-poll ${correctSet.has(normalize(a.text))?'correct':''}"><div><span>${esc(a.text)}</span><b>${a.percent}%</b></div><i><span style="width:${a.percent}%"></span></i></div>`).join(''):'<p class="player-muted">Пока никто не ответил.</p>'}`;
}
function loadPersonalResult(qid){
  const request=++resultRequest;
  fetch(`/api/player/question-result?participant_id=${encodeURIComponent(pid)}&question_id=${encodeURIComponent(qid)}`).then(r=>r.json().then(j=>({ok:r.ok,data:j}))).then(({ok,data})=>{
    if(!ok||request!==resultRequest||!S?.current_question||S.current_question.id!==qid||!S.answers_revealed)return;
    const q=S.current_question,choice=['single_choice','multiple_choice','true_false'].includes(q.question_type),correctSet=new Set(String(data.correct_answer||'').split(',').map(normalize).filter(Boolean)),selectedSet=new Set(String(data.answer||'').split(',').map(normalize).filter(Boolean));
    const verdict=data.answered?(data.is_correct?`<div class="personal-verdict correct"><b>✓ Вы ответили правильно</b><span>Ваш ответ: ${esc(data.answer)} · +${data.awarded_points} балл.</span></div>`:`<div class="personal-verdict wrong"><b>✕ Вы ответили неправильно</b><span>Ваш ответ: ${esc(data.answer)}</span></div>`):'<div class="personal-verdict unanswered"><b>Вы не отправили ответ на этот вопрос</b></div>';
    $('playerPersonalResult').innerHTML=verdict;
    if(choice){$('playerResults').innerHTML+=`<div class="player-revealed-choices"><div class="player-muted">ПРАВИЛЬНЫЙ ВАРИАНТ — ЗЕЛЁНЫЙ · ВАШ НЕВЕРНЫЙ ОТВЕТ — КРАСНЫЙ</div>${(q.options||[]).map(o=>`<div class="player-revealed-choice ${correctSet.has(normalize(o))?'is-correct':''} ${selectedSet.has(normalize(o))&&!correctSet.has(normalize(o))?'is-wrong':''}"><span>${esc(o)}</span>${correctSet.has(normalize(o))?'<b>✓ ПРАВИЛЬНО</b>':selectedSet.has(normalize(o))?'<b>✕ ВАШ ОТВЕТ</b>':''}</div>`).join('')}</div>${data.explanation?`<p class="player-muted">${esc(data.explanation)}</p>`:''}`;
    }else{$('playerResults').innerHTML+=`<div class="player-correct"><small>ПРАВИЛЬНЫЙ ОТВЕТ</small><b>${esc(data.correct_answer||'Не указан организатором')}</b></div>${data.explanation?`<p class="player-muted">${esc(data.explanation)}</p>`:''}`;}
  }).catch(()=>{});
}
function renderReactions(s){const counts=s.reaction_counts||[];$('reactionFeed').innerHTML=counts.map(x=>`<span class="reaction-chip">${esc(x.emoji)} ${x.count}</span>`).join('')||'<span class="player-muted">Пока нет реакций</span>';}
function timerMarkup(q,s){
  if(!q.time_limit)return '';
  const total=Number(q.time_limit),remaining=Math.max(0,Math.min(total,Number(s.timer_remaining??total))),percent=Math.round(remaining/total*100);
  return `<div class="player-timer ${s.answers_revealed?'frozen':''} ${remaining<=10&&!s.answers_revealed?'urgent':''}" id="playerTimerBox"><div class="player-timer-head"><span>ВРЕМЯ НА ОТВЕТ</span><strong><span id="playerTimerValue">${remaining}</span><small>сек.</small></strong></div><div class="player-timer-track"><i id="playerTimerBar" style="width:${percent}%"></i></div><div class="player-timer-state" id="playerTimerState">${s.answers_revealed?(remaining===0?'Время вышло':'Ответы открыты · таймер остановлен'):'Успейте отправить ответ'}</div></div>`;
}
function updatePlayerTimer(s){
  const q=s.current_question||{},box=$('playerTimerBox');if(!box||!q.time_limit)return;
  const total=Number(q.time_limit),remaining=Math.max(0,Math.min(total,Number(s.timer_remaining??total))),percent=Math.round(remaining/total*100);
  const value=$('playerTimerValue'),bar=$('playerTimerBar'),state=$('playerTimerState');
  if(value)value.textContent=String(remaining);
  if(bar)bar.style.width=percent+'%';
  if(state)state.textContent=s.answers_revealed?(remaining===0?'Время вышло':'Ответы открыты · таймер остановлен'):'Успейте отправить ответ';
  box.classList.toggle('frozen',!!s.answers_revealed);box.classList.toggle('urgent',remaining<=10&&!s.answers_revealed);
}
function render(s){
  S=s;if(!s.game)return;
  const fullMedia=s.screen_mode==='media_fullscreen'&&s.screen_media,fullHost=$('playerFullscreenMedia');
  if(fullHost){
    fullHost.classList.toggle('hidden',!fullMedia);
    if(fullMedia){
      const m=s.screen_media;
      if(m.type==='image')fullHost.innerHTML=`<img class="player-fullscreen-image" src="${esc(m.url)}" alt="${esc(m.name||'Изображение')}">`;
      else if(m.type==='video')fullHost.innerHTML=`<div class="player-fullscreen-video"><div id="playerFullscreenMediaMount" class="player-fullscreen-media-mount"></div><div id="playerFullscreenMediaStatus" class="media-sync-status"></div><div id="playerFullscreenMediaNotice" class="media-sync-notice hidden"><span data-media-notice-text>Разрешите воспроизведение</span><button type="button" onclick="QuizMediaSync.unlock()">Включить видео и звук</button></div></div>`;
      else fullHost.innerHTML='<p class="player-muted">Формат файла не поддерживается.</p>';
      return;
    }
    fullHost.innerHTML='';
  }
  if(pid&&!s.participants.some(p=>Number(p.id)===Number(pid))){presence();return;}
  if(!pid){const canRegister=!!s.game.allow_registration;$('joined').classList.add('hidden');$('register').classList.toggle('hidden',!canRegister);$('registerClosed').classList.toggle('hidden',canRegister);$('name').disabled=!canRegister;$('joinButton').disabled=!canRegister||registering;if(canRegister)$('err').textContent='';return;}
  showJoined();const me=s.participants.find(p=>p.id===pid);$('hello').textContent=me?`Привет, ${me.name}!`:'Вы подключены!';$('gameInfo').textContent=`${s.game.title} · ${s.format==='team'?'Командный формат':'Индивидуальная игра'}`;
  const q=s.current_question,roundSummary=s.screen_mode==='round_summary'&&s.round_summary;
  if(q&&q.id!==lastQuestion){lastQuestion=q.id;submitted=false;lastResultQuestion=0;$('answerStatus').textContent='';$('playerPersonalResult').innerHTML='';}
  $('joinedWelcome').classList.toggle('hidden',!(!q&&(s.screen_mode==='welcome'||!!roundSummary)));
  $('answerBox').classList.toggle('hidden',!q||!s.allow_answers||s.answers_revealed||!!roundSummary);
  $('resultBox').classList.toggle('hidden',!q||!s.answers_revealed||!!roundSummary);
  $('scorePanel').classList.toggle('hidden',(!(roundSummary||s.status==='finished'))||!s.game.show_scoreboard);
  if(roundSummary){
    const top=(roundSummary.scoreboard||[]).slice(0,3).map((p,i)=>`<div class="player-round-score-row"><span class="player-place">${['🥇','🥈','🥉'][i]||i+1}</span><b>${esc(p.name)}</b><span class="player-round-points">+${p.round_score||0}<small>за раунд</small></span><strong class="player-total-points">${p.score||0}<small>всего</small></strong></div>`).join('');
    $('current').innerHTML=`<div class="player-question-meta">РАУНД ЗАВЕРШЁН</div><h2>${esc(roundSummary.title)} — итоги</h2><p class="player-muted">Показаны баллы за этот раунд и общий счёт игры.</p>${top}`;
  }else if(!q){
    $('current').innerHTML='<h2>Ожидаем начало игры</h2><p class="player-muted">Следите за главным экраном. Новый вопрос появится здесь автоматически.</p>';
  }else{
    const syncedMedia=['audio','video'].includes(q.media_type)&&q.media?`<div class="player-synced-media"><div class="player-media-label">${q.media_type==='audio'?'♫ АУДИОТРЕК':'▶ ВИДЕО'} · УПРАВЛЯЕТ ВЕДУЩИЙ</div><div id="playerMediaMount" class="player-media-mount"></div><div id="playerMediaStatus" class="media-sync-status"></div><div id="playerMediaNotice" class="media-sync-notice hidden"><span data-media-notice-text>Разрешите воспроизведение</span><button type="button" onclick="QuizMediaSync.unlock()">${q.media_type==='video'?'Включить видео и звук':'Включить звук'}</button></div></div>`:'';
    $('current').innerHTML=`${timerMarkup(q,s)}<div class="player-question-meta">${esc(q.round_title||'Раунд')}</div><div class="player-question-title">${esc(q.body?(q.title||'ВОПРОС'):'ВОПРОС')}</div><h2 class="player-question-body">${esc(q.body||q.title||'Вопрос')}</h2>${q.media_type==='image'&&q.media?`<img class="player-media" src="${esc(q.media)}">`:''}${syncedMedia}${!s.allow_answers?'<div class="joined-note">Отвечайте устно — организатор зафиксирует баллы.</div>':''}${s.answers_revealed?'<div class="player-closed">Время ответов завершено</div>':''}`;
  }
  if(q&&s.allow_answers&&!s.answers_revealed){
    if(submitted){$('answerControl').innerHTML='<div class="submitted-message">✓ Ваш ответ принят. Ожидайте завершения вопроса.</div>';$('answerBox').querySelector('button').disabled=true;}
    else{$('answerBox').querySelector('button').disabled=false;const t=q.question_type||'open_text',opts=q.options||[];
      if(t==='single_choice'||t==='true_false')$('answerControl').innerHTML=opts.map((o,i)=>`<label class="player-choice"><input type="radio" name="playerAnswer" value="${esc(o)}"><span class="choice-letter">${String.fromCharCode(65+i)}</span><span>${esc(o)}</span></label>`).join('');
      else if(t==='multiple_choice')$('answerControl').innerHTML=opts.map((o,i)=>`<label class="player-choice"><input type="checkbox" name="playerAnswer" value="${esc(o)}"><span class="choice-letter">${String.fromCharCode(65+i)}</span><span>${esc(o)}</span></label>`).join('');
      else $('answerControl').innerHTML='<textarea name="playerAnswer" placeholder="Напишите ваш ответ…"></textarea>';
    }
  }
  if(q&&s.answers_revealed){$('playerResults').innerHTML=s.allow_answers?renderStats(s):'';if(lastResultQuestion!==q.id){lastResultQuestion=q.id;loadPersonalResult(q.id);}}
  $('scores').innerHTML=(s.scoreboard||[]).map((p,i)=>`<div class="player-score-row"><span class="player-place">${i+1}</span><b>${esc(p.name)}</b><strong>${p.score}</strong></div>`).join('')||'<p class="player-muted">Пока нет результатов.</p>';
  renderReactions(s);
}
function renderAndSync(s){render(s);const fullscreen=s.screen_mode==='media_fullscreen'&&s.screen_media?.type==='video';window.QuizMediaSync?.apply(s,fullscreen?{mountId:'playerFullscreenMediaMount',statusId:'playerFullscreenMediaStatus',noticeId:'playerFullscreenMediaNotice'}:{mountId:'playerMediaMount',statusId:'playerMediaStatus',noticeId:'playerMediaNotice'});}
function connect(){
  const proto=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(`${proto}://${location.host}/ws`);let sig='';
  ws.onmessage=e=>{try{const s=JSON.parse(e.data),x={...s};delete x.timer_remaining;delete x.reaction_events;delete x.reaction_counts;delete x.server_time;x.participants=(s.participants||[]).map(p=>({id:p.id,name:p.name,group_name:p.group_name,score:p.score,round_score:p.round_score}));if(!s.answers_revealed){delete x.answer_count;delete x.answer_stats;}if(!(s.screen_mode==='round_summary'||s.status==='finished'))delete x.scoreboard;const next=JSON.stringify(x);if(next!==sig){sig=next;renderAndSync(s);}else{updatePlayerTimer(s);renderReactions(s);const fullscreen=s.screen_mode==='media_fullscreen'&&s.screen_media?.type==='video';window.QuizMediaSync?.apply(s,fullscreen?{mountId:'playerFullscreenMediaMount',statusId:'playerFullscreenMediaStatus',noticeId:'playerFullscreenMediaNotice'}:{mountId:'playerMediaMount',statusId:'playerMediaStatus',noticeId:'playerMediaNotice'});}}catch(err){console.error(err)}};
  ws.onclose=()=>setTimeout(connect,1800);ws.onerror=()=>ws.close();
}
fetch('/api/state').then(r=>r.json()).then(renderAndSync).catch(console.error);connect();setInterval(presence,12000);
Object.assign(window,{register,sendAnswer,sendReaction,renderAndSync});
