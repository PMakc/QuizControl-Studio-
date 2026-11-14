const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalize=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g,' ');
const gameNames={classic:'КЛАССИЧЕСКИЙ КВИЗ',music:'УГАДАЙ МЕЛОДИЮ',video:'ВИДЕО-КВИЗ',mixed:'СМЕШАННАЯ ИГРА',custom:'СВОЙ СЦЕНАРИЙ'};
const medals=['🥇','🥈','🥉'];
let S=null;
let activeMicStream=null,micAudioContext=null,micAnalyser=null,micFrame=0,micStartPending=false,micDenied=false,micCanvasRef=null;
let lastSoundEventSequence=0,soundEventsInitialized=false,lastTickQuestion=0,lastTickSecond=null;
let timerLoopSource=null,timerLoopUrl='',timerLoopQuestion=0;
const cueBuffers={},cueLoading={},cueSources={};let cueAudioContext=null,cueSoundsUnlocked=false;
let wheelLoopSource=null,wheelLoopGain=null,wheelLoopUrl=null,wheelLoopPendingUrl=null;
let wheelVisual={roundId:0,spinId:0,angle:0,animation:null,wasSpinning:false};
function revealSoundUnlockButton(){const button=document.getElementById('soundUnlockButton');if(button&&!cueSoundsUnlocked){button.classList.remove('hidden');button.textContent='♫ Включить звуки';}}
async function unlockCueSounds(){
  const button=document.getElementById('soundUnlockButton');
  try{const C=window.AudioContext||window.webkitAudioContext;if(!C)throw new Error('Web Audio API не поддерживается этим браузером.');if(!cueAudioContext)cueAudioContext=new C();await cueAudioContext.resume();if(cueAudioContext.state!=='running')throw new Error('Браузер не разрешил воспроизведение звука.');cueSoundsUnlocked=true;if(button){button.textContent='✓ Звуки включены';button.classList.add('unlocked');button.disabled=true;}if(S){syncTimerLoop(S);syncWheelSpinSound(S);} }
  catch(e){if(button){button.textContent='Повторить включение звука';button.disabled=false;}console.warn('Не удалось включить звуки',e);}
}
async function playCue(type){
  const url=soundCueUrl(type);
  if(!url){if(type.startsWith('wheel_'))playWheelTone(type);return;}
  if(!cueAudioContext||cueAudioContext.state!=='running'){revealSoundUnlockButton();return;}
  try{if(!cueBuffers[url]){if(!cueLoading[url])cueLoading[url]=fetch(url).then(r=>{if(!r.ok)throw new Error('Файл звука не найден');return r.arrayBuffer();}).then(b=>cueAudioContext.decodeAudioData(b)).then(buffer=>(cueBuffers[url]=buffer)).finally(()=>{delete cueLoading[url];});await cueLoading[url];}
    const old=cueSources[type];if(old){try{old.stop();}catch(e){}}const source=cueAudioContext.createBufferSource();source.buffer=cueBuffers[url];source.connect(cueAudioContext.destination);cueSources[type]=source;source.onended=()=>{if(cueSources[type]===source)delete cueSources[type];};source.start(0);
  }catch(e){console.debug('Audio cue could not be played',e);if(type.startsWith('wheel_'))playWheelTone(type);}
}
function playWheelTone(type){
  if(!cueAudioContext||cueAudioContext.state!=='running'){revealSoundUnlockButton();return;}
  const patterns={wheel_correct:[{f:660,t:0,d:.13},{f:880,t:.13,d:.2}],wheel_wrong:[{f:260,t:0,d:.17},{f:185,t:.16,d:.25}],wheel_solved:[{f:523.25,t:0,d:.22},{f:659.25,t:.16,d:.22},{f:783.99,t:.32,d:.22},{f:1046.5,t:.48,d:.45}]};
  try{const ctx=cueAudioContext,now=ctx.currentTime;for(const note of (patterns[type]||[])){const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type=type==='wheel_wrong'?'sawtooth':'triangle';osc.frequency.setValueAtTime(note.f,now+note.t);gain.gain.setValueAtTime(.0001,now+note.t);gain.gain.exponentialRampToValueAtTime(type==='wheel_wrong'?.09:.13,now+note.t+.018);gain.gain.exponentialRampToValueAtTime(.0001,now+note.t+note.d);osc.connect(gain);gain.connect(ctx.destination);osc.start(now+note.t);osc.stop(now+note.t+note.d+.02);}}catch(e){console.debug('Wheel sound failed',e);}
}
function stopWheelSpinSound(){
  wheelLoopPendingUrl=null;
  if(wheelLoopGain&&cueAudioContext){const now=cueAudioContext.currentTime;try{wheelLoopGain.gain.cancelScheduledValues(now);wheelLoopGain.gain.setTargetAtTime(.0001,now,.035);}catch(e){}const source=wheelLoopSource;wheelLoopSource=null;wheelLoopGain=null;wheelLoopUrl=null;if(source){try{source.stop(now+.18);}catch(e){}}}
}
async function syncWheelSpinSound(s){
  const spinning=!!(s?.wheel_state?.spinning&&s?.active_round?.round_type==='wheel');
  if(!spinning){stopWheelSpinSound();return;}
  if(!cueAudioContext||cueAudioContext.state!=='running'){revealSoundUnlockButton();return;}
  const url=soundCueUrl('wheel_spin'),loopKey=url||'__builtin__';if((wheelLoopSource&&wheelLoopUrl===loopKey)||wheelLoopPendingUrl===loopKey)return;
  stopWheelSpinSound();wheelLoopPendingUrl=loopKey;
  try{
    let buffer;
    if(url){
      if(!cueBuffers[url]){if(!cueLoading[url])cueLoading[url]=fetch(url).then(r=>{if(!r.ok)throw new Error('Файл звука не найден');return r.arrayBuffer();}).then(b=>cueAudioContext.decodeAudioData(b)).then(value=>(cueBuffers[url]=value)).finally(()=>{delete cueLoading[url];});await cueLoading[url];}
      buffer=cueBuffers[url];
    }else{
      const ctx=cueAudioContext,sr=ctx.sampleRate,length=Math.floor(sr*.72);buffer=ctx.createBuffer(1,length,sr);const data=buffer.getChannelData(0);
      // A short ratcheting tick pattern loops smoothly while the wheel is moving.
      for(let tick=0;tick<6;tick++){const start=Math.floor((tick*.12)*sr);for(let j=0;j<Math.floor(sr*.045)&&start+j<length;j++){const envelope=Math.exp(-j/(sr*.008));data[start+j]+=(Math.random()*2-1)*envelope*.22;}}
    }
    if(wheelLoopPendingUrl!==loopKey||!S?.wheel_state?.spinning)return;
    const source=cueAudioContext.createBufferSource(),gain=cueAudioContext.createGain();source.buffer=buffer;source.loop=true;gain.gain.value = url ? 0.12 : 0.18;source.connect(gain);gain.connect(cueAudioContext.destination);source.start(0);wheelLoopSource=source;wheelLoopGain=gain;wheelLoopUrl=loopKey;wheelLoopPendingUrl=null;
  }catch(e){if(wheelLoopPendingUrl===loopKey)wheelLoopPendingUrl=null;console.debug('Wheel spin sound could not be started',e);}
}


function mediaHtml(q){
  if(!q.media)return '';
  const src=esc(q.media);
  if(q.media_type==='audio')return `<div class="stage-media-audio"><div class="audio-icon">♫</div><div class="media-track-label">АУДИОТРЕК · УПРАВЛЯЕТ ВЕДУЩИЙ</div><div id="stageMediaMount" class="stage-media-mount"></div><div id="stageMediaStatus" class="media-sync-status"></div><div id="stageMediaNotice" class="media-sync-notice hidden"><span data-media-notice-text>Разрешите воспроизведение</span><button type="button" onclick="QuizMediaSync.unlock()">Включить звук</button></div></div>`;
  if(q.media_type==='video')return `<div class="stage-media-video-wrap"><div id="stageMediaMount" class="stage-media-mount"></div><div id="stageMediaStatus" class="media-sync-status"></div><div id="stageMediaNotice" class="media-sync-notice hidden"><span data-media-notice-text>Разрешите воспроизведение</span><button type="button" onclick="QuizMediaSync.unlock()">Включить видео и звук</button></div></div>`;
  if(q.media_type==='image')return `<img class="stage-image" src="${src}" alt="Иллюстрация к вопросу">`;
  return '';
}
function correctValues(q){return new Set(String(q.correct_answer||'').split(',').map(normalize).filter(Boolean));}
function statsHtml(s){
  if(!s.answers_revealed)return '';
  const q=s.current_question||{},stats=s.answer_stats||[],correctSet=correctValues(q);
  return `<section class="reveal-panel"><div class="reveal-head"><div><div class="orange-kicker">ОТВЕТЫ УЧАСТНИКОВ</div><h2>Как отвечали игроки</h2></div><div class="answer-total">${s.answer_count||0}<small>ответов</small></div></div>${stats.length?stats.map(a=>`<div class="poll-row ${correctSet.has(normalize(a.text))?'correct':''}"><div class="poll-label"><span>${esc(a.text)}</span><b>${a.percent}%</b></div><div class="poll-track"><i style="width:${a.percent}%"></i></div></div>`).join(''):'<p class="stage-muted">Ответов пока нет</p>'}<div class="correct-answer"><span>ПРАВИЛЬНЫЙ ОТВЕТ</span><strong>${esc(q.correct_answer||'Не указан организатором')}</strong></div>${q.explanation?`<p class="explanation">${esc(q.explanation)}</p>`:''}</section>`;
}
function optionHtml(q,s){
  const options=q.options||[],correct=correctValues(q);
  return options.map((o,i)=>{
    const isCorrect=!!s.answers_revealed&&correct.has(normalize(o));
    return `<div class="stage-option ${isCorrect?'correct-option':''}"><span>${String.fromCharCode(65+i)}</span><b>${esc(o)}</b>${isCorrect?'<em class="correct-option-label">✓ ПРАВИЛЬНО</em>':''}</div>`;
  }).join('');
}
function rankRow(p,i,{round=false}={}){
  const podium=i<3?` podium podium-${i+1}`:'';
  const place=i<3?medals[i]:String(i+1).padStart(2,'0');
  if(round)return `<div class="stage-rank${podium}"><span class="place">${place}</span><div class="rank-name">${esc(p.name)}<small>${esc(p.group_name||'')}</small></div><div class="round-score-value">+${p.round_score||0}<small>ЗА РАУНД</small></div><div class="total-score-value">${p.score||0}<small>ВСЕГО</small></div></div>`;
  return `<div class="stage-rank${podium}"><span class="place">${place}</span><div class="rank-name">${esc(p.name)}<small>${esc(p.group_name||'')}</small></div><b>${p.score||0}<small>баллов</small></b></div>`;
}
let seenReactionId=0;
function renderReactions(s){
  const layer=document.getElementById('reactionLayer');
  if(!layer)return;
  for(const r of (s.reaction_events||[])){
    if(r.id<=seenReactionId)continue;
    seenReactionId=Math.max(seenReactionId,r.id);
    const el=document.createElement('div');el.className='reaction-float';el.style.left=(8+Math.random()*82)+'%';
    el.innerHTML=`${esc(r.emoji)}<span>${esc(r.name)}</span>`;layer.appendChild(el);setTimeout(()=>el.remove(),3600);
  }
}
function renderReactionCounter(s){
  const el=document.getElementById('reactionCounter');if(!el)return;
  const counts=s.reaction_counts||[],total=counts.reduce((n,x)=>n+Number(x.count||0),0);
  el.innerHTML=`<div class="reaction-counter-title">РЕАКЦИИ · ${total}</div><div class="reaction-counter-items">${counts.map(x=>`<span>${esc(x.emoji)} <b>${x.count}</b></span>`).join('')||'<span class="reaction-counter-empty">Пока нет</span>'}</div>`;
}
function timerPercent(s){
  const q=s.current_question||{},total=Number(q.time_limit||0);
  if(!total)return 100;
  const remaining=Math.max(0,Math.min(total,Number(s.timer_remaining??total)));
  return Math.round(remaining/total*100);
}
function updateStageTimer(s){
  const q=s.current_question||{},value=document.getElementById('stageTimerValue'),bar=document.getElementById('stageTimerBar');
  if(!value||!q.time_limit)return;
  const remaining=Math.max(0,Number(s.timer_remaining??q.time_limit));
  value.textContent=String(remaining);
  if(bar)bar.style.width=timerPercent(s)+'%';
  const qid=Number(q.id||0);if(qid!==lastTickQuestion){lastTickQuestion=qid;lastTickSecond=null;}
  const ring=value.closest('.stage-timer');
  if(ring){ring.classList.toggle('ended',remaining===0);ring.classList.toggle('stopped',!!s.answers_revealed);}
}
function soundCueUrl(type){return S?.active_round?.sound_settings?.[type]||S?.game?.sound_settings?.[type]||'';}
function stopTimerLoop(){if(timerLoopSource){try{timerLoopSource.stop();}catch(e){}timerLoopSource=null;}timerLoopUrl='';timerLoopQuestion=0;}
async function syncTimerLoop(s){
  const q=s?.current_question,url=soundCueUrl('timer_loop'),remaining=Number(s?.timer_remaining);
  const shouldPlay=!!(q&&s.screen_mode==='question'&&Number(q.time_limit)>0&&!s.answers_revealed&&remaining>0&&url);
  if(!shouldPlay){stopTimerLoop();return;}
  if(!cueAudioContext||cueAudioContext.state!=='running'){revealSoundUnlockButton();return;}
  if(timerLoopSource&&timerLoopUrl===url&&timerLoopQuestion===Number(q.id))return;
  stopTimerLoop();const qid=Number(q.id);
  try{if(!cueBuffers[url]){if(!cueLoading[url])cueLoading[url]=fetch(url).then(r=>{if(!r.ok)throw new Error('Файл звука не найден');return r.arrayBuffer();}).then(b=>cueAudioContext.decodeAudioData(b)).then(buffer=>(cueBuffers[url]=buffer)).finally(()=>{delete cueLoading[url];});await cueLoading[url];}
    if(!S?.current_question||Number(S.current_question.id)!==qid||S.answers_revealed||Number(S.timer_remaining)<=0)return;
    const source=cueAudioContext.createBufferSource();source.buffer=cueBuffers[url];source.loop=true;source.connect(cueAudioContext.destination);source.start(0);timerLoopSource=source;timerLoopUrl=url;timerLoopQuestion=qid;
  }catch(e){console.debug('Timer loop could not be played',e);}
}
function playKaraokeFanfare(){
  if(!cueAudioContext||cueAudioContext.state!=='running'){revealSoundUnlockButton();return;}
  try{const ctx=cueAudioContext,now=ctx.currentTime;[523.25,659.25,783.99,1046.5].forEach((f,i)=>{const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='triangle';osc.frequency.value=f;gain.gain.setValueAtTime(.0001,now+i*.16);gain.gain.exponentialRampToValueAtTime(.17,now+i*.16+.025);gain.gain.exponentialRampToValueAtTime(.0001,now+i*.16+.38);osc.connect(gain);gain.connect(ctx.destination);osc.start(now+i*.16);osc.stop(now+i*.16+.4);});}catch(e){console.debug('Karaoke fanfare failed',e);}
}
function playKaraokeDrumroll(){
  if(!cueAudioContext||cueAudioContext.state!=='running'){revealSoundUnlockButton();return;}
  try{const ctx=cueAudioContext,now=ctx.currentTime;for(let i=0;i<8;i++){const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='square';osc.frequency.value=160+i*22;gain.gain.setValueAtTime(.0001,now+i*.19);gain.gain.exponentialRampToValueAtTime(.055,now+i*.19+.012);gain.gain.exponentialRampToValueAtTime(.0001,now+i*.19+.1);osc.connect(gain);gain.connect(ctx.destination);osc.start(now+i*.19);osc.stop(now+i*.19+.12);}}catch(e){console.debug('Karaoke drumroll failed',e);}
}
function handleSoundEvents(s){
  syncTimerLoop(s);syncWheelSpinSound(s);
  const ev=s.sound_event||{},seq=Number(ev.sequence||0);if(!soundEventsInitialized){lastSoundEventSequence=seq;soundEventsInitialized=true;return;}if(seq<=lastSoundEventSequence)return;lastSoundEventSequence=seq;
  if(ev.type==='answer_reveal')playCue('answer_reveal');else if(ev.type==='answer_submit')playCue('answer_submit');else if(ev.type==='round_summary')playCue('round_summary');else if(ev.type==='karaoke_counting')playKaraokeDrumroll();else if(ev.type==='karaoke_results_open')playCue('karaoke_results_open');else if(ev.type==='karaoke_points_show'){playCue('karaoke_points_show');playKaraokeFanfare();}else if(ev.type==='wheel_correct')playCue('wheel_correct');else if(ev.type==='wheel_wrong')playCue('wheel_wrong');else if(ev.type==='wheel_solved')playCue('wheel_solved');
}
function stopMicVisualizer(){if(micFrame)cancelAnimationFrame(micFrame);micFrame=0;if(activeMicStream){activeMicStream.getTracks().forEach(t=>t.stop());activeMicStream=null;}if(micAudioContext){micAudioContext.close().catch(()=>{});micAudioContext=null;}micAnalyser=null;micCanvasRef=null;micStartPending=false;}
async function startMicVisualizer(){
  const canvas=document.getElementById('micVisualizerCanvas');if(!canvas||micStartPending)return;if(activeMicStream){if(micCanvasRef!==canvas)drawMicVisualizer();return;}micStartPending=true;micDenied=false;
  const status=document.getElementById('micVisualizerStatus');if(status)status.textContent='Запрашиваем доступ к микрофону…';
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Микрофон недоступен. Откройте главный экран через localhost или HTTPS.');
    activeMicStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:true},video:false});
    const C=window.AudioContext||window.webkitAudioContext;if(!C)throw new Error('Web Audio API не поддерживается этим браузером.');
    micAudioContext=new C();await micAudioContext.resume();const source=micAudioContext.createMediaStreamSource(activeMicStream);micAnalyser=micAudioContext.createAnalyser();micAnalyser.fftSize=1024;micAnalyser.smoothingTimeConstant=.78;source.connect(micAnalyser);if(status)status.textContent='Микрофон активен · звук визуализируется';drawMicVisualizer();
  }catch(e){micDenied=true;if(status)status.textContent=e.message||'Не удалось получить доступ к микрофону';const button=document.getElementById('micVisualizerStart');if(button)button.classList.remove('hidden');}
  finally{micStartPending=false;}
}
function drawMicVisualizer(){
  const canvas=document.getElementById('micVisualizerCanvas');if(!canvas||!micAnalyser)return;if(micFrame)cancelAnimationFrame(micFrame);micFrame=0;micCanvasRef=canvas;const ctx=canvas.getContext('2d'),w=canvas.width=canvas.clientWidth*devicePixelRatio,h=canvas.height=canvas.clientHeight*devicePixelRatio;const bins=micAnalyser.frequencyBinCount,data=new Uint8Array(bins),wave=new Uint8Array(micAnalyser.fftSize);
  function frame(){if(!micAnalyser||!canvas.isConnected)return;micAnalyser.getByteFrequencyData(data);micAnalyser.getByteTimeDomainData(wave);ctx.clearRect(0,0,w,h);const bars=72,step=Math.floor(bins/bars),gap=4*devicePixelRatio,bw=(w-gap*(bars-1))/bars;for(let i=0;i<bars;i++){let v=0;for(let j=0;j<step;j++)v+=data[i*step+j]||0;v/=step;const bh=Math.max(5*devicePixelRatio,v/255*h*.83),x=i*(bw+gap),y=(h-bh)/2;const grad=ctx.createLinearGradient(0,y,0,y+bh);grad.addColorStop(0,'#ffbd75');grad.addColorStop(.55,'#ff7a25');grad.addColorStop(1,'#d94815');ctx.fillStyle=grad;ctx.beginPath();ctx.roundRect(x,y,bw,bh,bw/2);ctx.fill();}ctx.strokeStyle='rgba(255,255,255,.5)';ctx.lineWidth=2*devicePixelRatio;ctx.beginPath();for(let i=0;i<wave.length;i+=3){const x=i/wave.length*w,y=h*.5+(wave[i]-128)/128*h*.18;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();micFrame=requestAnimationFrame(frame);}
  frame();
}
function endMicVisualizer(){stopMicVisualizer();const status=document.getElementById('micVisualizerStatus');if(status)status.textContent='Микрофон отключён';document.getElementById('micVisualizerStart')?.classList.remove('hidden');}
function wheelCurrentAngle(disc){
  if(!disc)return wheelVisual.angle||0;
  const transform=getComputedStyle(disc).transform;
  if(!transform||transform==='none')return wheelVisual.angle||0;
  try{const matrix=new DOMMatrixReadOnly(transform);return (Math.atan2(matrix.b,matrix.a)*180/Math.PI+360)%360;}catch(e){return wheelVisual.angle||0;}
}
function startWheelSpin(disc,spinId){
  if(!disc)return;const current=wheelCurrentAngle(disc);if(wheelVisual.animation){try{wheelVisual.animation.cancel();}catch(e){}}
  disc.style.transform=`rotate(${current}deg)`;wheelVisual.animation=disc.animate([{transform:`rotate(${current}deg)`},{transform:`rotate(${current+360}deg)`}],{duration:1250,iterations:Infinity,easing:'linear'});
  wheelVisual.spinId=spinId;wheelVisual.angle=current;wheelVisual.wasSpinning=true;
}
function stopWheelSpin(disc,targetIndex,sectorCount){
  if(!disc)return;const current=wheelCurrentAngle(disc);if(wheelVisual.animation){try{wheelVisual.animation.cancel();}catch(e){}}wheelVisual.animation=null;
  disc.style.transform=`rotate(${current}deg)`;const count=Math.max(1,Number(sectorCount)||1),index=Math.max(0,Number(targetIndex)||0)%count,step=360/count;
  const desired=((360-(index+.5)*step)%360+360)%360,currentMod=((current%360)+360)%360,delta=((desired-currentMod+360)%360)+360*4,end=current+delta;
  const animation=disc.animate([{transform:`rotate(${current}deg)`},{transform:`rotate(${end}deg)`}],{duration:2850,easing:'cubic-bezier(.12,.72,.16,1)',fill:'forwards'});
  wheelVisual.animation=animation;wheelVisual.wasSpinning=false;wheelVisual.angle=current;
  animation.onfinish=()=>{disc.style.transform=`rotate(${end}deg)`;wheelVisual.angle=end%360;if(wheelVisual.animation===animation)wheelVisual.animation=null;try{animation.cancel();}catch(e){}};
}
function wheelGradient(count){const colors=['#f97316','#fbbf24','#2563eb','#16a34a','#dc2626','#7c3aed','#0891b2','#ea580c','#eab308','#2563eb','#16a34a','#dc2626'];const n=Math.max(1,count);return `conic-gradient(${Array.from({length:n},(_,i)=>`${colors[i%colors.length]} ${i*360/n}deg ${(i+1)*360/n}deg`).join(',')})`;}
function wheelStageMarkup(s,w,sectors){
  const n=Math.max(1,sectors.length),distance=window.innerWidth<=800?130:175,labels=sectors.map((v,i)=>{const a=(i+.5)*360/n;return `<span style="transform:rotate(${a}deg) translateY(-${distance}px) rotate(${-a}deg)">${esc(v)}</span>`;}).join('');
  return `<section class="wheel-stage"><div class="orange-kicker">ПОЛЕ ЧУДЕС</div><div class="wheel-stage-layout"><div class="wheel-disc-wrap"><div class="wheel-pointer">▼</div><div class="wheel-disc" id="wheelDisc" style="background:${wheelGradient(n)}"><div class="wheel-disc-center">QC</div>${labels}</div><div class="wheel-sector-result" id="wheelSectorResult">БАРАБАН</div></div><div class="wheel-board-side"><div class="wheel-public-metrics"><span>КОМАНДЫ <b id="wheelTeamCount">0</b></span><span>ОЧКОВ ЗА РАУНД <b id="wheelRoundTotal">0</b></span><span>ВСЕГО ОЧКОВ <b id="wheelTotal">0</b></span></div><div class="wheel-turn">СЕЙЧАС ИГРАЕТ <b id="wheelCurrentTeam">Ожидаем команды</b></div><div class="wheel-word" id="wheelWord"></div><div class="wheel-opened" id="wheelOpened"></div><div class="wheel-history" id="wheelHistory"></div></div></div><div class="wheel-public-scoreboard" id="wheelPublicScoreboard"></div></section>`;
}
function renderWheelStage(s,root){
  const w=s.wheel_state||{},sectors=w.sector_values||[],rid=Number(s.active_round_id||0),spinId=Number(w.spin_id||0);let disc=root.querySelector('#wheelDisc');
  if(!root.querySelector('.wheel-stage')||wheelVisual.roundId!==rid){if(wheelVisual.animation){try{wheelVisual.animation.cancel();}catch(e){}}wheelVisual={roundId:rid,spinId:0,angle:0,animation:null,wasSpinning:false};root.innerHTML=wheelStageMarkup(s,w,sectors);disc=root.querySelector('#wheelDisc');}
  if(!disc)return;
  if(w.spinning&&(!wheelVisual.wasSpinning||wheelVisual.spinId!==spinId))startWheelSpin(disc,spinId);
  else if(!w.spinning&&wheelVisual.wasSpinning&&wheelVisual.spinId===spinId)stopWheelSpin(disc,w.spin_target_index,sectors.length);
  disc.classList.toggle('is-spinning',!!w.spinning);
  const currentTeam=(w.teams||[])[Number(w.team_index||0)],result=w.spinning?'БАРАБАН ВРАЩАЕТСЯ':w.spin_value!=null?`ВЫПАЛО: ${w.spin_value}`:w.last_spin_value!=null?`ПОСЛЕДНИЙ СЕКТОР: ${w.last_spin_value}`:'БАРАБАН';
  root.querySelector('#wheelSectorResult').textContent=result;
  root.querySelector('#wheelTeamCount').textContent=String(w.team_count??(w.teams||[]).length);
  root.querySelector('#wheelRoundTotal').textContent=String(w.round_points_total||0);
  root.querySelector('#wheelTotal').textContent=String(w.total_points||0);
  root.querySelector('#wheelCurrentTeam').textContent=currentTeam?.name||'Команды не подключены';
  root.querySelector('#wheelWord').innerHTML=(w.mask||[]).map(ch=>`<span>${ch==='_'?'　':esc(ch)}</span>`).join('');
  root.querySelector('#wheelOpened').textContent=`Открытые буквы: ${(w.opened||[]).join(' · ')||'—'}`;
  root.querySelector('#wheelHistory').innerHTML=(w.history||[]).slice(-8).map(x=>`<span class="${x.found?'found':'miss'}">${esc(x.letter)}${Number(x.points||0)?` +${Number(x.points)}`:''}</span>`).join('');
  const rows=(w.teams||[]).map((team,i)=>`<div class="wheel-public-score-row ${i===Number(w.team_index||0)?'is-current':''}"><span class="wheel-score-place">${i+1}</span><b>${esc(team.name)}</b><strong>${Number(team.score||0)} <small>всего</small></strong><em>+${Number(team.round_score||0)} за раунд</em></div>`).join('');
  root.querySelector('#wheelPublicScoreboard').innerHTML=`<div class="wheel-public-score-head"><b>СЧЁТ КОМАНД</b><span>${w.teams?.length||0} команд</span></div><div class="wheel-public-score-list">${rows||'<p class="stage-muted">Ожидаем регистрации команд</p>'}</div>`;
  document.getElementById('stageRound').textContent='ПОЛЕ ЧУДЕС';
}

function render(s){
  handleSoundEvents(s);if(s.screen_mode!=='audio_visualizer')stopMicVisualizer();
  renderReactions(s);renderReactionCounter(s);
  const root=document.getElementById('content'),g=s.game,q=s.current_question;
  const fullMedia=s.screen_mode==='media_fullscreen'&&s.screen_media;
  document.getElementById('displayRoot').classList.toggle('media-fullscreen-active',!!fullMedia);
  document.getElementById('gameName').textContent=g?.title||'QUIZCONTROL STUDIO';
  if(fullMedia){
    const m=s.screen_media;
    const kstate=s.active_round?.round_type==='karaoke'?(s.karaoke_state||{}):null;
    const karaokeOverlay=kstate&&['counting','waiting_singers','result_intro','result'].includes(kstate.status)?`<div class="karaoke-score-overlay ${kstate.status==='result'?'has-result':''}">${kstate.status==='counting'?'<div class="karaoke-counting-display"><div class="karaoke-score-spinner"></div><div class="orange-kicker">ОЦЕНИВАЕМ ВЫСТУПЛЕНИЕ</div><h2>Подсчитываем баллы</h2><p>Система определяет результат…</p></div>':kstate.status==='waiting_singers'?'<div class="karaoke-counting-display"><div class="orange-kicker">КАРАОКЕ · ТРЕК ЗАВЕРШЁН</div><h2>Ожидаем исполнителей</h2><p>Ведущий назначит участников в пульте.</p></div>':kstate.status==='result_intro'?'<div class="karaoke-counting-display"><div class="orange-kicker">КАРАОКЕ · ВЫСТУПЛЕНИЕ ЗАВЕРШЕНО</div><h2>Подводим итоги</h2><p>Результаты готовы к объявлению…</p></div>':`<div class="karaoke-result-display"><div class="orange-kicker">РЕЗУЛЬТАТ ВЫСТУПЛЕНИЯ</div><h2>Ваши баллы</h2><div class="karaoke-score-cards">${(kstate.results||[]).map(r=>`<div class="karaoke-score-card"><b>${esc(r.name)}</b><strong>${r.points}</strong><small>БАЛЛОВ</small>${(kstate.winner_names||[]).includes(r.name)?'<em>ПОБЕДИТЕЛЬ</em>':''}</div>`).join('')}</div><p class="karaoke-winner-line">🏆 Победитель: ${esc((kstate.winner_names||[]).join(', '))}</p></div>`}</div>`:'';
    if(m.type==='image')root.innerHTML=`<div class="fullscreen-media-frame"><img class="fullscreen-media-image" src="${esc(m.url)}" alt="${esc(m.name||'Изображение')}">${karaokeOverlay}</div>`;
    else if(m.type==='video')root.innerHTML=`<div class="fullscreen-media-frame fullscreen-video-frame"><div id="stageMediaMount" class="fullscreen-media-mount"></div><div id="stageMediaStatus" class="fullscreen-media-status"></div><div id="stageMediaNotice" class="media-sync-notice hidden"><span data-media-notice-text>Разрешите воспроизведение</span><button type="button" onclick="QuizMediaSync.unlock()">Включить видео и звук</button></div>${karaokeOverlay}</div>`;
    else root.innerHTML='<div class="fullscreen-media-frame"><div class="stage-muted">Формат файла не поддерживается для полноэкранного показа</div></div>';
    return;
  }
  if(s.active_round?.round_type==='wheel'&&s.screen_mode!=='round_summary'&&s.wheel_state?.round_id===s.active_round_id){
    renderWheelStage(s,root);return;
  }
  if(s.screen_mode==='audio_visualizer'){
    root.innerHTML=`<section class="mic-visualizer-stage"><div class="orange-kicker">АКУСТИЧЕСКАЯ ВИЗУАЛИЗАЦИЯ</div><h1>${esc(s.active_round?.title||'Звук с микрофона')}</h1><p>Говорите, пойте или включите музыку — визуализатор реагирует на звук с микрофона компьютера.</p><div class="mic-orbit"><div class="mic-glow"></div><div class="mic-symbol">♫</div></div><canvas id="micVisualizerCanvas" class="mic-visualizer-canvas"></canvas><div id="micVisualizerStatus" class="mic-visualizer-status">Подключаем микрофон…</div><button id="micVisualizerStart" class="btn primary hidden" onclick="startMicVisualizer()">Разрешить микрофон / Повторить</button><button class="mic-stop-link" onclick="endMicVisualizer()">Отключить микрофон</button></section>`;
    startMicVisualizer();return;
  }
  document.getElementById('stageRound').textContent=q?esc(q.round_title||'ТЕКУЩИЙ РАУНД'):(s.active_round?.title?esc(s.active_round.title):(g?gameNames[g.game_type]||'ИГРА':'ГОТОВЫ К ИГРЕ'));
  if(!g){root.innerHTML='<div class="stage-empty">Создайте игру в панели организатора</div>';return;}
  if(s.screen_mode==='round_summary'&&s.round_summary){
    const summary=s.round_summary,rows=(summary.scoreboard||[]).map((p,i)=>rankRow(p,i,{round:true})).join('');
    root.innerHTML=`<div class="score-stage round-summary-stage"><div class="orange-kicker">РАУНД ЗАВЕРШЁН</div><h1>Итоги раунда</h1><p class="round-summary-title">${esc(summary.title)}</p><div class="round-summary-total">${summary.round_points_total||0}<small>баллов начислено за раунд</small></div><div class="stage-leaderboard">${rows||'<p class="stage-muted">В раунде пока нет результатов</p>'}</div><p class="stage-muted round-summary-footer">Ожидаем следующий раунд</p></div>`;
    return;
  }
  if(s.screen_mode==='scoreboard'){
    const rows=(s.scoreboard||[]).map((p,i)=>rankRow(p,i)).join('');
    root.innerHTML=`<div class="score-stage"><div class="orange-kicker">ТЕКУЩИЕ РЕЗУЛЬТАТЫ</div><h1>Таблица лидеров</h1><div class="stage-leaderboard">${rows||'<p class="stage-muted">Результатов пока нет</p>'}</div></div>`;
    return;
  }
  if(s.screen_mode==='question'&&q){
    const opts=optionHtml(q,s);
    const remaining=Math.max(0,Number(s.timer_remaining??q.time_limit??0));
    const timer=q.time_limit?`<div class="stage-timer-wrap"><div class="stage-timer ${remaining===0?'ended':''} ${s.answers_revealed?'stopped':''}"><span id="stageTimerValue">${remaining}</span><small>СЕКУНД</small></div><div class="stage-timer-progress"><i id="stageTimerBar" style="width:${timerPercent(s)}%"></i></div></div>`:'';
    root.innerHTML=`<div class="question-stage"><div class="question-kicker"><span class="orange-kicker">${esc(q.round_title||'РАУНД')}</span><span class="points-pill">${q.points} БАЛЛ.</span></div><div class="question-layout"><div class="question-copy"><div class="question-title-label">${esc(q.body?(q.title||'ВОПРОС'):'ВОПРОС')}</div><h1>${esc(q.body||q.title||'Вопрос')}</h1>${mediaHtml(q)}${opts?`<div class="stage-options">${opts}</div>`:''}</div><aside class="question-aside">${timer}<div class="answer-status ${s.answers_revealed?'done':''}">${s.answers_revealed?'ОТВЕТЫ ОТКРЫТЫ':s.allow_answers?'ПРИЁМ ОТВЕТОВ':'ОТВЕТЫ УСТНО'}</div>${s.answers_revealed?'<div class="reveal-badge">РЕЗУЛЬТАТЫ ОТКРЫТЫ</div>':''}</aside></div>${statsHtml(s)}</div>`;
    return;
  }
  root.innerHTML=`<div class="welcome-layout"><div class="welcome-copy"><div class="orange-kicker">${s.status==='active'?'МЕРОПРИЯТИЕ ИДЁТ':'ДОБРО ПОЖАЛОВАТЬ'}</div><h1>${esc(g.title)}</h1><p>${esc(g.description||'Приготовьтесь проверить свои знания!')}</p><div class="welcome-facts"><span>${s.rounds.length} РАУНДОВ</span><span>${s.format==='team'?'КОМАНДНАЯ ИГРА':'ИНДИВИДУАЛЬНАЯ ИГРА'}</span><span>${esc(gameNames[g.game_type]||'КВИЗ')}</span></div></div><div class="join-card"><div class="join-card-title">ПОДКЛЮЧИТЬСЯ К ИГРЕ</div><img class="qr" src="/api/connect-qr" alt="QR-код для подключения"><div class="join-url" id="joinUrl">Отсканируйте QR-код телефоном</div><div class="join-hint">${g.allow_registration?'Регистрация открыта':'Регистрация закрыта'}</div></div></div>`;
}
function connect(){
  const proto=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(`${proto}://${location.host}/ws`);let sig='';
  ws.onmessage=e=>{try{
    const s=JSON.parse(e.data),x={...s};S=s;handleSoundEvents(s);delete x.timer_remaining;delete x.reaction_events;delete x.reaction_counts;delete x.server_time;delete x.participants;
    if(s.screen_mode!=='scoreboard')delete x.scoreboard;
    if(!s.answers_revealed){delete x.answer_count;delete x.answer_stats;}
    const next=JSON.stringify(x);renderReactions(s);renderReactionCounter(s);
    if(next!==sig){sig=next;render(s);}else updateStageTimer(s);
    window.QuizMediaSync?.apply(s,{mountId:'stageMediaMount',statusId:'stageMediaStatus',noticeId:'stageMediaNotice'});
  }catch(err){console.error(err)}};
  ws.onclose=()=>setTimeout(connect,1800);ws.onerror=()=>ws.close();
}
fetch('/api/state').then(r=>r.json()).then(s=>{S=s;handleSoundEvents(s);render(s);window.QuizMediaSync?.apply(s,{mountId:'stageMediaMount',statusId:'stageMediaStatus',noticeId:'stageMediaNotice'});}).catch(console.error);
fetch('/api/connect-qr').then(r=>{const u=r.headers.get('X-Join-Url');if(u)document.querySelectorAll('.join-url').forEach(el=>el.textContent=u)}).catch(()=>{});
connect();

Object.assign(window,{startMicVisualizer,endMicVisualizer,unlockCueSounds});
