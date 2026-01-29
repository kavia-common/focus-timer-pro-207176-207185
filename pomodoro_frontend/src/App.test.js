import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders the Focus Timer Pro header", () => {
  render(<App />);
  expect(screen.getByText(/Focus Timer Pro/i)).toBeInTheDocument();
});

test("shows Start button initially", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument();
});
