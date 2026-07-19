(() => {
  const screens = [...document.querySelectorAll('[data-screen]')];
  const scenarioRows = [...document.querySelectorAll('.scenario-row')];
  const scenarioBindings = [...document.querySelectorAll('[data-bind="scenario"]')];
  const conversationOrb = document.getElementById('conversation-orb');
  const conversationState = document.getElementById('conversation-state');
  const conversationTimer = document.getElementById('conversation-timer');
  const conversationQuestion = document.getElementById('conversation-question');
  const conversationScenario = document.getElementById('conversation-scenario');
  const metricDuration = document.getElementById('metric-duration');
  const themeColor = document.querySelector('meta[name="theme-color"]');

  const scenarios = {
    general: {
      name: 'Conversación general',
      question: 'Cuéntame en pocas palabras: ¿por qué SAS y por qué ahora?'
    },
    davivienda: {
      name: 'Davivienda',
      question: '¿Cómo reducirías el riesgo de integración con los sistemas actuales?'
    },
    aval: {
      name: 'Grupo Aval',
      question: '¿Cómo demostrarías valor medible para distintas entidades del grupo?'
    }
  };

  const AGENT_SPEAKING_MS = 2600;
  let selectedScenario = 'general';
  let timerId = null;
  let stateCycleId = null;
  let agentStartId = null;
  let processingId = null;
  let elapsed = 0;

  function clearPendingTimers() {
    if (agentStartId) window.clearTimeout(agentStartId);
    if (processingId) window.clearTimeout(processingId);
    agentStartId = null;
    processingId = null;
  }

  function showScreen(name) {
    screens.forEach(screen => {
      const active = screen.dataset.screen === name;
      screen.classList.toggle('is-active', active);
      screen.setAttribute('aria-hidden', String(!active));
      if (active) screen.scrollTop = 0;
    });

    document.body.dataset.screen = name;
    themeColor?.setAttribute('content', name === 'conversation' ? '#030818' : '#fbf6ef');

    if (name !== 'conversation') stopSessionClock();
    if (name !== 'processing') {
      if (processingId) window.clearTimeout(processingId);
      processingId = null;
    }
  }

  function updateScenarioUI() {
    const data = scenarios[selectedScenario];
    scenarioBindings.forEach(el => { el.textContent = data.name; });
    conversationQuestion.textContent = data.question;
    conversationScenario.textContent = `Escenario · ${data.name}`;
  }

  function selectScenario(key) {
    if (!scenarios[key]) return;
    selectedScenario = key;
    scenarioRows.forEach(row => {
      const selected = row.dataset.scenario === key;
      row.classList.toggle('is-selected', selected);
      row.setAttribute('aria-checked', String(selected));
    });
    updateScenarioUI();
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const remainingSeconds = (seconds % 60).toString().padStart(2, '0');
    return `${minutes}:${remainingSeconds}`;
  }

  function setAgentState(state) {
    const labels = {
      listening: 'Escuchando',
      thinking: 'Analizando',
      speaking: 'Interlocutor hablando'
    };
    conversationOrb.dataset.orbState = state;
    conversationState.textContent = labels[state] || state;
  }

  function startSessionClock() {
    stopSessionClock();
    elapsed = 0;
    conversationTimer.textContent = '00:00';
    setAgentState('listening');

    timerId = window.setInterval(() => {
      elapsed += 1;
      conversationTimer.textContent = formatTime(elapsed);
    }, 1000);

    const states = ['listening', 'thinking', 'speaking', 'listening'];
    let stateIndex = 0;
    stateCycleId = window.setInterval(() => {
      stateIndex = (stateIndex + 1) % states.length;
      setAgentState(states[stateIndex]);
    }, 6500);
  }

  function stopSessionClock() {
    if (timerId) window.clearInterval(timerId);
    if (stateCycleId) window.clearInterval(stateCycleId);
    if (agentStartId) window.clearTimeout(agentStartId);
    timerId = null;
    stateCycleId = null;
    agentStartId = null;
  }

  function finishSession() {
    stopSessionClock();
    metricDuration.textContent = elapsed > 0 ? formatTime(elapsed) : '02:14';
    showScreen('processing');
    processingId = window.setTimeout(() => showScreen('report'), 1800);
  }

  document.getElementById('login-form').addEventListener('submit', event => {
    event.preventDefault();
    showScreen('selection');
  });

  document.getElementById('toggle-password').addEventListener('click', event => {
    const input = document.getElementById('password');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    event.currentTarget.setAttribute('aria-label', visible ? 'Mostrar contraseña' : 'Ocultar contraseña');
  });

  scenarioRows.forEach(row => row.addEventListener('click', () => selectScenario(row.dataset.scenario)));

  document.querySelectorAll('[data-go]').forEach(button => {
    button.addEventListener('click', () => {
      clearPendingTimers();
      showScreen(button.dataset.go);
    });
  });

  document.getElementById('start-session').addEventListener('click', () => {
    updateScenarioUI();
    showScreen('conversation');
    conversationTimer.textContent = '00:00';
    setAgentState('speaking');
    agentStartId = window.setTimeout(startSessionClock, AGENT_SPEAKING_MS);
  });

  document.getElementById('end-session').addEventListener('click', finishSession);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    });
  }

  window.smartprSimulator = {
    showScreen,
    selectScenario,
    setAgentState,
    finishSession
  };

  screens.forEach(screen => screen.setAttribute('aria-hidden', String(!screen.classList.contains('is-active'))));
  updateScenarioUI();
})();
