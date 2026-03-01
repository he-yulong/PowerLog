from django.db import models
from django.core.validators import MinValueValidator


class TrainingEntry(models.Model):
    EXERCISE_CHOICES = [
        ('squat', 'Squat'),
        ('bench', 'Bench Press'),
        ('deadlift', 'Deadlift'),
        ('custom', 'Custom'),
    ]

    date = models.DateField()
    exercise_type = models.CharField(max_length=20, choices=EXERCISE_CHOICES)
    exercise_name = models.CharField(max_length=100)  # Custom name if exercise_type is 'custom'
    weight = models.DecimalField(max_digits=6, decimal_places=2, validators=[MinValueValidator(0)])
    sets = models.IntegerField(validators=[MinValueValidator(1)])
    reps = models.IntegerField(validators=[MinValueValidator(1)])
    rpe = models.DecimalField(max_digits=3, decimal_places=1, null=True, blank=True, validators=[MinValueValidator(0)])
    notes = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-date', '-created_at']
        verbose_name_plural = 'Training Entries'

    def __str__(self):
        return f"{self.date} - {self.exercise_name} ({self.weight}kg x {self.sets}x{self.reps})"
