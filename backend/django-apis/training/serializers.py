from rest_framework import serializers
from .models import TrainingEntry


class TrainingEntrySerializer(serializers.ModelSerializer):
    class Meta:
        model = TrainingEntry
        fields = ['id', 'date', 'exercise_type', 'exercise_name', 'weight', 'sets', 'reps', 'rpe', 'notes', 'created_at']
        read_only_fields = ['id', 'created_at']

    def validate_weight(self, value):
        if value <= 0:
            raise serializers.ValidationError("Weight must be a positive number.")
        return value

    def validate_sets(self, value):
        if value < 1:
            raise serializers.ValidationError("Sets must be at least 1.")
        return value

    def validate_reps(self, value):
        if value < 1:
            raise serializers.ValidationError("Reps must be at least 1.")
        return value

    def validate_rpe(self, value):
        if value is not None and (value < 0 or value > 10):
            raise serializers.ValidationError("RPE must be between 0 and 10.")
        return value

    def validate(self, data):
        # If exercise_type is not 'custom', set exercise_name to match the type
        if data.get('exercise_type') != 'custom':
            exercise_names = {
                'squat': 'Squat',
                'bench': 'Bench Press',
                'deadlift': 'Deadlift',
            }
            data['exercise_name'] = exercise_names.get(data['exercise_type'], data.get('exercise_name', ''))
        return data
