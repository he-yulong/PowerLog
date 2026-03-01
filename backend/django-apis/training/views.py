from rest_framework import generics
from .models import TrainingEntry
from .serializers import TrainingEntrySerializer


class TrainingEntryListCreateView(generics.ListCreateAPIView):
    queryset = TrainingEntry.objects.all()
    serializer_class = TrainingEntrySerializer
