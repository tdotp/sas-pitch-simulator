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

  // Duración simulada de la locución del agente antes de empezar a grabar.
  // En integración real esto se reemplaza por el evento "agent finished
  // speaking" del SDK de ElevenLabs, no por un timeout fijo.
  const AGENT_SPEAKING_MS = 2600;

  let selectedScenario = 'general';
  let timerId = null;
  let stateCycleId = null;
  let elapsed = 0;

  function showScreen(name) {
    screens.forEach(screen => screen.classList.toggle('is-active', screen.dataset.screen === name));
    if (name !== 'conversation') stopSessionClock();
  }

  function updateScenarioUI() {
    const data = scenarios[selectedScenario];
    scenarioBindings.forEach(el => el.textContent = data.name);
    conversationQuestion.textContent = data.question;
    conversationScenario.textContent = `Escenario · ${data.name}`;
  }

  function selectScenario(key) {
    selectedScenario = key;
    scenarioRows.forEach(row => {
      const selected = row.dataset.scenario === key;
      row.classList.toggle('is-selected', selected);
      row.setAttribute('aria-checked', String(selected));
    });
    updateScenarioUI();
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function setAgentState(state) {
    const labels = { listening: 'Escuchando', thinking: 'Analizando', speaking: 'Interlocutor hablando' };
    conversationOrb.dataset.orbState = state;
    conversationState.textContent = labels[state] || state;
  }

  function startSessionClock() {
    stopSessionClock();
    elapsed = 0;
    conversationTimer.textContent = '00:00';
    setAgentState('listening'); // el agente ya terminó de hablar; ahora graba
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
    timerId = null;
    stateCycleId = null;
  }

  function finishSession() {
    stopSessionClock();
    const displayedDuration = elapsed > 0 ? formatTime(elapsed) : '02:14';
    metricDuration.textContent = displayedDuration;
    showScreen('processing');
    window.setTimeout(() => showScreen('report'), 2300);
  }

  document.getElementById('login-form').addEventListener('submit', event => {
    event.preventDefault();
    showScreen('selection');
  });

  document.getElementById('toggle-password').addEventListener('click', () => {
    const input = document.getElementById('password');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
  });

  scenarioRows.forEach(row => row.addEventListener('click', () => selectScenario(row.dataset.scenario)));

  document.querySelectorAll('[data-go]').forEach(button => {
    button.addEventListener('click', () => {
      const target = button.dataset.go;
      showScreen(target);
    });
  });

  document.getElementById('start-session').addEventListener('click', () => {
    updateScenarioUI();
    showScreen('conversation');
    // El agente "habla" la pregunta primero; solo cuando termina arranca
    // el timer y pasa a "Escuchando" (grabando la respuesta de Sandra).
    window.setTimeout(() => {
      conversationTimer.textContent = '00:00';
      setAgentState('speaking');
    }, 380);
    window.setTimeout(startSessionClock, 380 + AGENT_SPEAKING_MS);
  });

  document.getElementById('end-session').addEventListener('click', finishSession);

  window.smartprSimulator = { showScreen, selectScenario, setAgentState, finishSession };
  updateScenarioUI();
})();
