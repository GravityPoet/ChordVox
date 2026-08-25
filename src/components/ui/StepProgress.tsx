import React from "react";
import { Check, LucideIcon } from "lucide-react";

interface Step {
  title: string;
  icon: LucideIcon;
}

interface StepProgressProps {
  steps: Step[];
  currentStep: number;
  className?: string;
}

export default function StepProgress({ steps, currentStep, className = "" }: StepProgressProps) {
  const boundedStep = Math.max(0, Math.min(currentStep, Math.max(steps.length - 1, 0)));
  const currentStepTitle = steps[boundedStep]?.title || "Progress";

  return (
    <div
      role="progressbar"
      aria-label={currentStepTitle}
      aria-valuemin={steps.length > 0 ? 1 : undefined}
      aria-valuemax={steps.length > 0 ? steps.length : undefined}
      aria-valuenow={steps.length > 0 ? boundedStep + 1 : undefined}
      aria-valuetext={steps.length > 0 ? currentStepTitle : undefined}
      className={`flex items-center justify-center gap-0.5 ${className}`}
    >
      {steps.map((step, index) => {
        const Icon = step.icon;
        const isActive = index === boundedStep;
        const isCompleted = index < boundedStep;

        return (
          <React.Fragment key={index}>
            <div
              aria-current={isActive ? "step" : undefined}
              aria-label={step.title}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-[transform,background-color,color,box-shadow] duration-200 ease-out ${
                isActive
                  ? "glass-chip glass-chip--accent text-primary scale-105 shadow-[var(--shadow-card)]"
                  : isCompleted
                    ? "text-success"
                    : "text-muted-foreground/40"
              }`}
            >
              <div
                className={`w-4.5 h-4.5 rounded-md flex items-center justify-center shrink-0 transition-[background-color,color,box-shadow] duration-200 ease-out ${
                  isActive
                    ? "bg-primary text-primary-foreground ring-2 ring-primary/25 ring-offset-1 ring-offset-background"
                    : isCompleted
                      ? "glass-chip glass-chip--success text-success"
                      : "bg-muted text-muted-foreground/40"
                }`}
              >
                {isCompleted ? (
                  <Check aria-hidden="true" className="w-2.5 h-2.5" strokeWidth={3} />
                ) : (
                  <Icon aria-hidden="true" className="w-2.5 h-2.5" />
                )}
              </div>
              <span
                className={`text-[10px] hidden md:block tracking-wide ${
                  isActive
                    ? "text-primary font-semibold"
                    : isCompleted
                      ? "text-success font-medium"
                      : "text-muted-foreground/40 font-normal"
                }`}
              >
                {step.title}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                aria-hidden="true"
                className={`h-px mx-0.5 transition-[width,background-color] duration-200 ${
                  isCompleted ? "w-3.5 bg-success/50" : "w-3 bg-border"
                }`}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
