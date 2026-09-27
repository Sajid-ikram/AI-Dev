let requested = false;

/**
 * Makes the first Ctrl+C a request to stop: running agents are stopped, and the job pauses so it
 * can be resumed. A second Ctrl+C exits at once.
 */
export function listenForInterrupt(): void {
  process.on('SIGINT', () => {
    if (requested) {
      console.log('\nStopping now.');
      process.exit(130);
    }
    requested = true;
    console.log('\nStopping after this step. Press Ctrl+C again to quit at once.');
  });
}

export function interruptRequested(): boolean {
  return requested;
}
